import { stat } from "node:fs/promises";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	addThreadConversation,
	loadChatConfig,
	removeConversation,
	resolveConversation,
	saveChatConfig,
	tmuxSafeName,
	type ResolvedConversation,
} from "./src/chat.js";
import {
	findByName,
	findByThreadConversationId,
	listForParent,
	normalizeThreadName,
	readCatalog,
	removeEntry,
	upsertEntry,
	writeCatalog,
	type ThreadCatalogEntry,
} from "./src/catalog.js";
import { closeDiscordThread, createDiscordThread, renameDiscordThread, sendDiscordChannelMessage, sendDiscordThreadIntro } from "./src/discord.js";
import { inheritChatGitConfig, removeChatGitConfig } from "./src/git.js";
import { inheritMounts, removeMountsForConversation } from "./src/mounts.js";
import { matchSlashCommand } from "./src/match.js";
import {
	forkSessionForThread,
	findMostRecentWorkerSession,
	getCurrentPiChatConversationId,
	getCurrentThreadState,
	type ThreadState,
} from "./src/session.js";
import { startThreadSupervisor } from "./src/supervisor.js";
import { isWorkerAlive, killWorker, startWorker } from "./src/worker.js";

type Verb = "start" | "stop" | "restart" | "kill" | "rename" | "list" | "help";

export interface Subcommand {
	verb: Verb;
	name?: string;
	newName?: string;
	parentConversationId?: string;
}

const VERBS: ReadonlySet<string> = new Set(["start", "stop", "restart", "kill", "rename", "list", "help"]);

function tokenize(raw: string): string[] {
	return raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((t) => t.replace(/^["']|["']$/g, "")) ?? [];
}

export function canPrompt(ctx: Pick<ExtensionContext, "hasUI">, forceNonInteractive = false): boolean {
	return !forceNonInteractive && ctx.hasUI;
}

interface ParsedFlags {
	positional: string[];
	parentConversationId?: string;
}

function parseFlags(tokens: readonly string[]): ParsedFlags {
	const out: ParsedFlags = { positional: [] };
	for (const token of tokens) {
		if (token.startsWith("--parent=")) out.parentConversationId = token.slice("--parent=".length);
		else if (token.startsWith("--channel=")) out.parentConversationId = token.slice("--channel=".length);
		else if (token.startsWith("-")) throw new Error(`unknown flag: ${token}`);
		else out.positional.push(token);
	}
	return out;
}

export function parseSubcommand(raw: string): Subcommand {
	const tokens = tokenize(raw);
	if (tokens.length === 0) return { verb: "help" };

	const first = tokens[0].toLowerCase();
	if (first === "ls") return parseSubcommand(["list", ...tokens.slice(1)].join(" "));

	if (VERBS.has(first)) {
		const flags = parseFlags(tokens.slice(1));
		if (first === "rename") {
			const [name, ...rest] = flags.positional;
			return { verb: "rename", name, newName: rest.join(" ").trim() || undefined, parentConversationId: flags.parentConversationId };
		}
		const name = flags.positional.join(" ").trim() || undefined;
		return { verb: first as Verb, name, parentConversationId: flags.parentConversationId };
	}

	// Bare name is shorthand for `start <name>`.
	const flags = parseFlags(tokens);
	const name = flags.positional.join(" ").trim();
	if (!name) return { verb: "help" };
	return { verb: "start", name, parentConversationId: flags.parentConversationId };
}

const USAGE = [
	"Usage:",
	"  /chat-thread <name>                 Shorthand for `start <name>`.",
	"  /chat-thread start <name>           Start a new thread, or attach to an existing one (auto-restart if stopped).",
	"  /chat-thread stop [name]            Stop the current thread (no name) or a named thread (from the parent channel).",
	"  /chat-thread restart [name]         Force-restart the current thread or a named one. Recreates the tmux worker.",
	"  /chat-thread kill [name]            Stop, delete local config, and close the Discord thread.",
	"  /chat-thread rename <target> <name> Rename a managed thread locally and in Discord.",
	"  /chat-thread list                   List threads for the connected channel and show worker status.",
	"  /chat-thread <verb> --parent=<a/b>  Specify parent channel when no pi-chat context is connected.",
].join("\n");

export function assertCanForkFromParent(parent: Pick<ResolvedConversation, "channel">): void {
	if (parent.channel.managedBy === "pi-ez-chat-threads") {
		throw new Error("/chat-thread cannot fork from inside an existing managed thread. Run /chat-thread from the parent channel instead.");
	}
}

async function resolveParent(
	config: Awaited<ReturnType<typeof loadChatConfig>>,
	explicitId: string | undefined,
	connectedConversationId: string | undefined,
): Promise<ResolvedConversation> {
	const selectedId = explicitId ?? connectedConversationId;
	if (!selectedId) throw new Error("No pi-chat conversation is connected. Pass --parent=<account/channel> or run /chat-connect first.");
	const parent = resolveConversation(config, selectedId);
	if (!parent) throw new Error(`Configured pi-chat conversation not found: ${selectedId}`);
	if (parent.service !== "discord") throw new Error("/chat-thread currently supports Discord parent channels only.");
	return parent;
}

function describeThread(entry: ThreadCatalogEntry, workerAlive: boolean): string {
	const status = entry.stoppedAt ? `stopped at ${entry.stoppedAt}` : workerAlive ? "running" : "started but worker not running";
	return `- ${entry.name}  [${entry.normalizedName}]  ${status}\n    conversation: ${entry.threadConversationId}\n    thread id: ${entry.threadId}`;
}

async function listThreads(parent: ResolvedConversation): Promise<string> {
	const catalog = await readCatalog();
	const entries = listForParent(catalog, parent.conversationId);
	if (entries.length === 0) return `No managed threads for ${parent.conversationId}.`;
	const lines = [`Managed threads for ${parent.conversationId}:`];
	for (const entry of entries) {
		const alive = entry.stoppedAt ? false : isWorkerAlive(entry.threadConversationId);
		lines.push(describeThread(entry, alive));
	}
	return lines.join("\n");
}

async function existingSessionFile(path: string | undefined): Promise<string | undefined> {
	if (!path) return undefined;
	const info = await stat(path).catch(() => undefined);
	return info?.isFile() ? path : undefined;
}

async function createFreshThread(
	rawName: string,
	normalizedName: string,
	parent: ResolvedConversation,
	ctx: ExtensionContext,
): Promise<{ entry: ThreadCatalogEntry; message: string }> {
	const sourceSessionFile =
		(await existingSessionFile(ctx.sessionManager.getSessionFile())) ??
		(await existingSessionFile(await findMostRecentWorkerSession(parent.conversationId)));
	if (!sourceSessionFile) throw new Error("No source pi session found to fork. Send a message in the parent channel first, or run /chat-thread from a persisted pi session.");

	const config = await loadChatConfig();
	const created = await createDiscordThread({ account: parent.account, parentChannelId: parent.channel.id, name: rawName.slice(0, 90) });
	const createdAt = new Date().toISOString();
	let thread: ResolvedConversation | undefined;
	let mountInheritance: Awaited<ReturnType<typeof inheritMounts>> | undefined;
	let inheritedGit = false;
	let forked = "";
	let start: ReturnType<typeof startWorker> | undefined;
	try {
		thread = addThreadConversation({
			config,
			parent,
			threadId: created.id,
			threadName: created.name,
			sessionId: ctx.sessionManager.getSessionId(),
		});
		await saveChatConfig(config);
		mountInheritance = await inheritMounts(parent.conversationId, thread.conversationId);
		inheritedGit = await inheritChatGitConfig(parent.conversationId, thread.conversationId);

		const state: ThreadState = {
			parentConversationId: parent.conversationId,
			threadConversationId: thread.conversationId,
			threadId: created.id,
			threadName: created.name,
			createdAt,
		};
		forked = await forkSessionForThread({ sourceSessionFile, thread, threadState: state, workerCwd: ctx.cwd });
		start = startWorker({ conversationId: thread.conversationId, sessionFile: forked, cwd: ctx.cwd });
	} catch (error) {
		if (thread) {
			removeConversation(config, thread.conversationId);
			await saveChatConfig(config).catch(() => undefined);
			await removeMountsForConversation(thread.conversationId).catch(() => undefined);
			await removeChatGitConfig(thread.conversationId).catch(() => undefined);
		}
		await closeDiscordThread({ account: parent.account, threadId: created.id }).catch(() => undefined);
		throw error;
	}

	if (!thread || !mountInheritance || !start) throw new Error("Thread creation failed before worker startup completed.");

	const entry: ThreadCatalogEntry = {
		parentConversationId: parent.conversationId,
		threadConversationId: thread.conversationId,
		threadId: created.id,
		name: created.name,
		normalizedName,
		createdAt,
		stoppedAt: null,
		ownerSessionId: ctx.sessionManager.getSessionId(),
		lastSessionFile: forked,
	};
	const catalog = await readCatalog();
	upsertEntry(catalog, entry);
	await writeCatalog(catalog);

	await sendDiscordThreadIntro({
		account: parent.account,
		threadId: created.id,
		content: `Starting pi-chat thread **${created.name}**.`,
	});

	const message = [
		`Starting pi-chat thread ${created.name}.`,
		``,
		`  parent: ${parent.conversationId}`,
		`  conversation: ${thread.conversationId}`,
		`  thread id: ${created.id}`,
		`  inherited mounts: ${mountInheritance.inherited.length > 0 ? mountInheritance.inherited.join(", ") : "none (run /chat-mount in the parent channel before starting a thread if you want host repos available)"}`,
		`  inherited git config: ${inheritedGit ? "yes" : "no"}`,
		`  source session: ${sourceSessionFile}`,
		`  forked session: ${forked}`,
		`  worker: ${start.action} (${start.tmuxName})`,
	].join("\n");
	return { entry, message };
}

interface RestartParams {
	entry: ThreadCatalogEntry;
	parent: ResolvedConversation;
	ctx: ExtensionContext;
	postedDiscordNotice: boolean;
}

async function restartExistingThread(params: RestartParams): Promise<string> {
	const { entry, parent, ctx } = params;
	const sessionFile = entry.lastSessionFile ?? (await findMostRecentWorkerSession(entry.threadConversationId));
	if (!sessionFile) throw new Error(`No saved session file for thread '${entry.name}'; cannot restart worker.`);
	const start = startWorker({ conversationId: entry.threadConversationId, sessionFile, cwd: ctx.cwd, restart: true });
	entry.stoppedAt = null;
	entry.lastSessionFile = sessionFile;
	const catalog = await readCatalog();
	upsertEntry(catalog, entry);
	await writeCatalog(catalog);

	if (!params.postedDiscordNotice) {
		await sendDiscordChannelMessage({
			account: parent.account,
			channelId: entry.threadId,
			content: `Starting pi-chat thread **${entry.name}**.`,
		});
	}

	return [
		`Starting pi-chat thread ${entry.name}.`,
		``,
		`  conversation: ${entry.threadConversationId}`,
		`  thread id: ${entry.threadId}`,
		`  worker: ${start.action} (${start.tmuxName})`,
		`  session: ${sessionFile}`,
	].join("\n");
}

async function startOrAttach(rawName: string, parent: ResolvedConversation, ctx: ExtensionContext, verb: "start" | "restart"): Promise<string> {
	const normalizedName = normalizeThreadName(rawName);
	if (!normalizedName) throw new Error("Thread name must contain alphanumeric characters.");

	const catalog = await readCatalog();
	const existing = findByName(catalog, parent.conversationId, normalizedName);
	if (existing) {
		// Post the start notice in the thread before (re)starting so users see lifecycle clearly
		// in Discord. Best-effort; failures are silent.
		await sendDiscordChannelMessage({
			account: parent.account,
			channelId: existing.threadId,
			content: verb === "restart" ? `Restarting pi-chat thread **${existing.name}**.` : `Starting pi-chat thread **${existing.name}**.`,
		});
		return restartExistingThread({ entry: existing, parent, ctx, postedDiscordNotice: true });
	}

	if (verb === "restart") throw new Error(`No managed thread named '${rawName}' under ${parent.conversationId}.`);
	const { message } = await createFreshThread(rawName, normalizedName, parent, ctx);
	return message;
}

function resolveAccountForEntry(config: Awaited<ReturnType<typeof loadChatConfig>>, parent: ResolvedConversation | undefined, entry: ThreadCatalogEntry) {
	return (parent && parent.accountId === entry.threadConversationId.split("/")[0]
		? parent.account
		: config.accounts[entry.threadConversationId.split("/")[0]]);
}

function resolveThreadEntry(
	catalog: Awaited<ReturnType<typeof readCatalog>>,
	target: { name?: string },
	parent: ResolvedConversation | undefined,
	currentThread: ThreadState | undefined,
): ThreadCatalogEntry {
	if (target.name) {
		if (!parent) throw new Error("Specify --parent=<account/channel> or run from a channel with a connected parent.");
		const entry = findByName(catalog, parent.conversationId, normalizeThreadName(target.name));
		if (!entry) throw new Error(`No managed thread named '${target.name}' under ${parent.conversationId}.`);
		return entry;
	}
	if (!currentThread) throw new Error("Not inside a managed thread. Run from inside the thread, or pass a name from the parent channel.");
	const entry = findByThreadConversationId(catalog, currentThread.threadConversationId);
	if (!entry) throw new Error(`Current thread is not in the catalog (${currentThread.threadConversationId}).`);
	return entry;
}

async function stopThread(
	target: { name?: string },
	parent: ResolvedConversation | undefined,
	currentThread: ThreadState | undefined,
	options: { selfStop: boolean },
): Promise<string> {
	const catalog = await readCatalog();
	const entry = resolveThreadEntry(catalog, target, parent, currentThread);

	// Resolve the account once, since killing self-stops the worker and we need the bot token
	// to post the notice before tmux dies. Reuse parent if it matches; otherwise re-resolve.
	const config = await loadChatConfig();
	const account = resolveAccountForEntry(config, parent, entry);

	if (account?.service === "discord") {
		await sendDiscordChannelMessage({
			account,
			channelId: entry.threadId,
			content: `Stopping pi-chat thread **${entry.name}**.`,
		});
	}

	const killed = killWorker(entry.threadConversationId);
	if (!entry.stoppedAt) entry.stoppedAt = new Date().toISOString();
	upsertEntry(catalog, entry);
	await writeCatalog(catalog);

	const lines = [
		`Stopping pi-chat thread ${entry.name}.`,
		``,
		`  conversation: ${entry.threadConversationId}`,
		`  worker: ${killed ? "killed" : "was not running"}`,
		`  stopped at: ${entry.stoppedAt}`,
		`  session file kept: ${entry.lastSessionFile ?? "(none recorded)"}`,
	];
	if (options.selfStop) {
		lines.push("", "This worker is about to exit. Restart with /chat-thread start <name> from the parent channel.");
	}
	return lines.join("\n");
}

async function renameThread(
	target: { name?: string; newName?: string },
	parent: ResolvedConversation | undefined,
	currentThread: ThreadState | undefined,
): Promise<string> {
	if (!target.name) throw new Error("/chat-thread rename requires a <target> and <name>.");
	if (!target.newName) throw new Error("/chat-thread rename requires a new <name>.");
	const normalizedNewName = normalizeThreadName(target.newName);
	if (!normalizedNewName) throw new Error("New thread name must contain alphanumeric characters.");

	const catalog = await readCatalog();
	const entry = resolveThreadEntry(catalog, { name: target.name }, parent, currentThread);
	const conflict = parent ? findByName(catalog, parent.conversationId, normalizedNewName) : undefined;
	if (conflict && conflict.threadConversationId !== entry.threadConversationId) {
		throw new Error(`A managed thread named '${target.newName}' already exists under ${parent?.conversationId}.`);
	}

	const config = await loadChatConfig();
	const account = resolveAccountForEntry(config, parent, entry);
	if (account?.service === "discord") await renameDiscordThread({ account, threadId: entry.threadId, name: target.newName });

	entry.name = target.newName;
	entry.normalizedName = normalizedNewName;
	upsertEntry(catalog, entry);
	await writeCatalog(catalog);

	const resolved = resolveConversation(config, entry.threadConversationId);
	if (resolved) {
		resolved.channel.name = target.newName;
		await saveChatConfig(config);
	}

	return [
		`Renamed pi-chat thread ${target.name} -> ${target.newName}.`,
		``,
		`  conversation: ${entry.threadConversationId}`,
		`  thread id: ${entry.threadId}`,
	].join("\n");
}

async function killThread(
	target: { name?: string },
	parent: ResolvedConversation | undefined,
	currentThread: ThreadState | undefined,
	options: { selfKill: boolean },
): Promise<string> {
	const catalog = await readCatalog();
	const entry = resolveThreadEntry(catalog, target, parent, currentThread);
	const config = await loadChatConfig();
	const account = resolveAccountForEntry(config, parent, entry);

	if (account?.service === "discord") {
		await sendDiscordChannelMessage({
			account,
			channelId: entry.threadId,
			content: `Killing pi-chat thread **${entry.name}**. This will stop the worker, delete local thread configuration, and close this Discord thread.`,
		});
		await closeDiscordThread({ account, threadId: entry.threadId });
	}

	const killed = killWorker(entry.threadConversationId);
	const removedCatalog = removeEntry(catalog, entry.threadConversationId);
	await writeCatalog(catalog);
	const removedChatConfig = removeConversation(config, entry.threadConversationId);
	if (removedChatConfig) await saveChatConfig(config);
	const removedMounts = await removeMountsForConversation(entry.threadConversationId);
	const removedGit = await removeChatGitConfig(entry.threadConversationId);

	const lines = [
		`Killed pi-chat thread ${entry.name}.`,
		``,
		`  conversation: ${entry.threadConversationId}`,
		`  thread id: ${entry.threadId}`,
		`  worker: ${killed ? "killed" : "was not running"}`,
		`  catalog entry: ${removedCatalog ? "removed" : "not found"}`,
		`  pi-chat config: ${removedChatConfig ? "removed" : "not found"}`,
		`  mount config: ${removedMounts ? "removed" : "not found"}`,
		`  git config: ${removedGit ? "removed" : "not found"}`,
		`  Discord thread: closed`,
	];
	if (options.selfKill) lines.push("", "This worker is exiting now.");
	return lines.join("\n");
}

interface ResumeChoice {
	entry: ThreadCatalogEntry;
	parentName: string;
	workerAlive: boolean;
}

function resumeChoiceLabel(choice: ResumeChoice): string {
	return `${choice.entry.name}  ${choice.workerAlive ? "running" : "dormant"}  — ${choice.parentName}`;
}

async function listResumeChoices(parentConversationId?: string): Promise<ResumeChoice[]> {
	const [catalog, config] = await Promise.all([readCatalog(), loadChatConfig()]);
	const choices: ResumeChoice[] = [];
	for (const entry of Object.values(catalog.threads)) {
		if (parentConversationId && entry.parentConversationId !== parentConversationId) continue;
		if (!resolveConversation(config, entry.threadConversationId)) continue;
		const parent = resolveConversation(config, entry.parentConversationId);
		choices.push({
			entry,
			parentName: parent?.conversationName ?? entry.parentConversationId,
			workerAlive: isWorkerAlive(entry.threadConversationId),
		});
	}
	return choices.sort((a, b) => a.parentName.localeCompare(b.parentName) || a.entry.name.localeCompare(b.entry.name));
}

async function resolveResumeChoice(raw: string, ctx: ExtensionContext): Promise<ResumeChoice> {
	const flags = parseFlags(tokenize(raw));
	const name = flags.positional.join(" ").trim();
	const entries = ctx.sessionManager.getEntries();
	const currentThread = getCurrentThreadState(entries);
	const connectedConversationId = getCurrentPiChatConversationId(entries);
	const scopedParent = flags.parentConversationId ?? currentThread?.parentConversationId ?? connectedConversationId;
	const choices = await listResumeChoices(name ? undefined : scopedParent);
	if (choices.length === 0) throw new Error(scopedParent ? `No managed threads for ${scopedParent}.` : "No managed chat threads found.");

	if (!name) {
		if (!ctx.hasUI) throw new Error("/chat-resume requires a thread name when no local Pi UI is available.");
		const labels = choices.map(resumeChoiceLabel);
		const selected = await ctx.ui.select("Resume pi-chat thread", labels);
		if (!selected) throw new Error("Resume cancelled.");
		const index = labels.indexOf(selected);
		if (index < 0) throw new Error("Resume selection was not recognized.");
		return choices[index];
	}

	const normalized = normalizeThreadName(name);
	let matches = scopedParent && !flags.parentConversationId ? await listResumeChoices(scopedParent) : await listResumeChoices(flags.parentConversationId);
	matches = matches.filter((choice) => choice.entry.normalizedName === normalized);
	if (matches.length === 0 && scopedParent && !flags.parentConversationId) {
		matches = (await listResumeChoices()).filter((choice) => choice.entry.normalizedName === normalized);
	}
	if (matches.length === 0) throw new Error(`No managed thread named '${name}'.`);
	if (matches.length > 1) throw new Error(`Multiple managed threads named '${name}'. Pass --parent=<account/channel>.`);
	return matches[0];
}

async function resumeThreadSession(raw: string, ctx: ExtensionCommandContext): Promise<string | undefined> {
	const choice = await resolveResumeChoice(raw, ctx);
	const sessionFile =
		(await existingSessionFile(choice.entry.lastSessionFile)) ??
		(await existingSessionFile(await findMostRecentWorkerSession(choice.entry.threadConversationId)));
	if (!sessionFile) throw new Error(`No saved session file for thread '${choice.entry.name}'.`);

	if (choice.workerAlive) {
		if (!ctx.hasUI) throw new Error(`Thread '${choice.entry.name}' is already running. Stop it first or attach to ${isWorkerAlive(choice.entry.threadConversationId) ? "the tmux worker" : "it"}.`);
		const tmuxName = tmuxSafeName(choice.entry.threadConversationId);
		const attachCommand = `tmux attach -t ${tmuxName}`;
		const action = await ctx.ui.select(`Thread '${choice.entry.name}' is already running`, [
			"Take over here: stop worker and resume session",
			`Show attach command (${attachCommand})`,
			"Cancel",
		]);
		if (!action || action === "Cancel") return "Resume cancelled.";
		if (action.startsWith("Show attach command")) return `Attach to the running worker with:\n\n${attachCommand}`;
		const config = await loadChatConfig();
		const account = resolveAccountForEntry(config, undefined, choice.entry);
		if (account?.service === "discord") {
			await sendDiscordChannelMessage({
				account,
				channelId: choice.entry.threadId,
				content: `Taking over pi-chat thread **${choice.entry.name}** in a local Pi session.`,
			});
		}
		killWorker(choice.entry.threadConversationId);
		choice.entry.stoppedAt = new Date().toISOString();
		choice.entry.lastSessionFile = sessionFile;
		const catalog = await readCatalog();
		upsertEntry(catalog, choice.entry);
		await writeCatalog(catalog);
	}

	await ctx.switchSession(sessionFile);
	return undefined;
}

interface DispatchResult {
	message: string;
	/** True when the calling worker is about to be killed by this command. */
	selfStopped: boolean;
}

async function dispatch(raw: string, ctx: ExtensionContext): Promise<DispatchResult> {
	const sub = parseSubcommand(raw);
	if (sub.verb === "help") return { message: USAGE, selfStopped: false };

	const entries = ctx.sessionManager.getEntries();
	const connectedConversationId = getCurrentPiChatConversationId(entries);
	const currentThread = getCurrentThreadState(entries);

	if (sub.verb === "list") {
		const config = await loadChatConfig();
		const fallbackParent = currentThread?.parentConversationId;
		const parent = await resolveParent(config, sub.parentConversationId ?? fallbackParent, connectedConversationId);
		return { message: await listThreads(parent), selfStopped: false };
	}

	if (sub.verb === "stop") {
		const config = await loadChatConfig();
		const parentId = sub.parentConversationId ?? currentThread?.parentConversationId ?? connectedConversationId;
		const parent = parentId ? resolveConversation(config, parentId) : undefined;
		const selfStop = !sub.name && !!currentThread;
		const message = await stopThread({ name: sub.name }, parent, currentThread, { selfStop });
		return { message, selfStopped: selfStop };
	}

	if (sub.verb === "kill") {
		const config = await loadChatConfig();
		const parentId = sub.parentConversationId ?? currentThread?.parentConversationId ?? connectedConversationId;
		const parent = parentId ? resolveConversation(config, parentId) : undefined;
		const selfKill = !sub.name && !!currentThread;
		const message = await killThread({ name: sub.name }, parent, currentThread, { selfKill });
		return { message, selfStopped: selfKill };
	}

	if (sub.verb === "rename") {
		const config = await loadChatConfig();
		const parentId = sub.parentConversationId ?? currentThread?.parentConversationId ?? connectedConversationId;
		const parent = parentId ? resolveConversation(config, parentId) : undefined;
		const message = await renameThread({ name: sub.name, newName: sub.newName }, parent, currentThread);
		return { message, selfStopped: false };
	}

	// start | restart (with bare name → start)
	const name = sub.name;
	if (!name) {
		if (sub.verb === "restart" && currentThread) {
			// `/chat-thread restart` inside a thread: restart self.
			const config = await loadChatConfig();
			const parent = resolveConversation(config, currentThread.parentConversationId);
			if (!parent) throw new Error(`Parent conversation ${currentThread.parentConversationId} not found in pi-chat config.`);
			const catalog = await readCatalog();
			const entry = findByThreadConversationId(catalog, currentThread.threadConversationId);
			if (!entry) throw new Error(`Current thread is not in the catalog (${currentThread.threadConversationId}); cannot restart.`);
			await sendDiscordChannelMessage({
				account: parent.account,
				channelId: entry.threadId,
				content: `Restarting pi-chat thread **${entry.name}**.`,
			});
			// Self-restart: killing our own tmux session terminates the worker. The new session
			// will be spawned by startWorker, but the response message will not reach Discord
			// because our process dies. The Discord notice above is what the user will see.
			const message = await restartExistingThread({ entry, parent, ctx, postedDiscordNotice: true });
			return { message, selfStopped: true };
		}
		throw new Error(`/chat-thread ${sub.verb} requires a <name> (or run /chat-thread restart from inside a thread to restart it).`);
	}

	if (currentThread) throw new Error("Already inside a managed thread. Run /chat-thread stop or /chat-thread restart first, or run /chat-thread <name> from the parent channel.");
	const config = await loadChatConfig();
	const parent = await resolveParent(config, sub.parentConversationId, connectedConversationId);
	assertCanForkFromParent(parent);
	const message = await startOrAttach(name, parent, ctx, sub.verb as "start" | "restart");
	return { message, selfStopped: false };
}

function fenced(text: string): string {
	return `\`\`\`\n${text.replace(/```/g, "`​``")}\n\`\`\``;
}

export default function (pi: ExtensionAPI) {
	let stopSupervisor: (() => void) | undefined;

	pi.registerCommand("chat-resume", {
		description: "Resume a managed Discord thread-backed pi-chat session by thread name",
		handler: async (raw, ctx) => {
			try {
				const message = await resumeThreadSession(raw, ctx);
				if (message) ctx.ui.notify(message, "info");
			} catch (err) {
				ctx.ui.notify(`${(err as Error).message}\n\nUsage: /chat-resume [thread-name] [--parent=<account/channel>]`, "error");
			}
		},
	});

	pi.registerCommand("chat-thread", {
		description: "Manage persistent Discord-thread-backed pi-chat sessions (start/stop/restart/list)",
		handler: async (raw, ctx) => {
			try {
				const result = await dispatch(raw, ctx);
				ctx.ui.notify(result.message, "info");
			} catch (err) {
				ctx.ui.notify(`${(err as Error).message}\n\n${USAGE}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		stopSupervisor?.();
		stopSupervisor = startThreadSupervisor(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopSupervisor?.();
		stopSupervisor = undefined;
	});

	pi.on("input", async (event, ctx) => {
		const match = matchSlashCommand(event.text, ["chat-thread", "chat-ez-thread"]);
		if (!match) return { action: "continue" };
		try {
			const result = await dispatch(match.args, ctx);
			if (result.selfStopped) {
				// We have already posted the lifecycle message directly to Discord, and the
				// worker is about to die. Returning `handled` keeps the LLM from prefacing a
				// reply that will never be delivered.
				return { action: "handled" };
			}
			return {
				action: "transform",
				text: `The remote /chat-thread command completed. Reply to the user with exactly this fenced code block and no other text:\n\n${fenced(result.message)}`,
			};
		} catch (err) {
			return {
				action: "transform",
				text: `The remote /chat-thread command failed. Reply to the user with exactly this fenced code block and no other text:\n\n${fenced(`${(err as Error).message}\n\n${USAGE}`)}`,
			};
		}
	});
}
