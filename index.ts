import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	addThreadConversation,
	loadChatConfig,
	resolveConversation,
	saveChatConfig,
	type ResolvedConversation,
} from "./src/chat.js";
import {
	findByName,
	findByThreadConversationId,
	listForParent,
	normalizeThreadName,
	readCatalog,
	upsertEntry,
	writeCatalog,
	type ThreadCatalogEntry,
} from "./src/catalog.js";
import { createDiscordThread, sendDiscordThreadIntro } from "./src/discord.js";
import { inheritMounts } from "./src/mounts.js";
import { matchSlashCommand } from "./src/match.js";
import {
	forkSessionForThread,
	findMostRecentWorkerSession,
	getCurrentPiChatConversationId,
	getCurrentThreadState,
	type ThreadState,
} from "./src/session.js";
import { isWorkerAlive, killWorker, startWorker } from "./src/worker.js";

interface Subcommand {
	kind: "create" | "end" | "list" | "help";
	name?: string;
	parentConversationId?: string;
	reactivate?: boolean;
}

function tokenize(raw: string): string[] {
	return raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((t) => t.replace(/^["']|["']$/g, "")) ?? [];
}

export function canPrompt(ctx: Pick<ExtensionContext, "hasUI">, forceNonInteractive = false): boolean {
	return !forceNonInteractive && ctx.hasUI;
}

export function parseSubcommand(raw: string): Subcommand {
	const tokens = tokenize(raw);
	if (tokens.length === 0) return { kind: "help" };

	const first = tokens[0].toLowerCase();
	if (first === "end") {
		const rest = parseFlags(tokens.slice(1));
		const name = rest.positional.join(" ").trim() || undefined;
		return { kind: "end", name, parentConversationId: rest.parentConversationId };
	}
	if (first === "list" || first === "ls") {
		const rest = parseFlags(tokens.slice(1));
		return { kind: "list", parentConversationId: rest.parentConversationId };
	}
	if (first === "help") return { kind: "help" };

	const rest = parseFlags(tokens);
	const name = rest.positional.join(" ").trim();
	if (!name) return { kind: "help" };
	return { kind: "create", name, parentConversationId: rest.parentConversationId, reactivate: rest.reactivate };
}

interface ParsedFlags {
	positional: string[];
	parentConversationId?: string;
	reactivate?: boolean;
}

function parseFlags(tokens: readonly string[]): ParsedFlags {
	const out: ParsedFlags = { positional: [] };
	for (const token of tokens) {
		if (token === "--reactivate") out.reactivate = true;
		else if (token.startsWith("--parent=")) out.parentConversationId = token.slice("--parent=".length);
		else if (token.startsWith("--channel=")) out.parentConversationId = token.slice("--channel=".length);
		else if (token.startsWith("-")) throw new Error(`unknown flag: ${token}`);
		else out.positional.push(token);
	}
	return out;
}

const USAGE = [
	"Usage:",
	"  /chat-thread <name>                  Create or attach by name in the connected channel.",
	"  /chat-thread end                     End the current thread (run from inside the thread).",
	"  /chat-thread end <name>              End a named thread from the parent channel.",
	"  /chat-thread list                    List threads for the connected channel.",
	"  /chat-thread <name> --reactivate     Reuse an ended thread name (revive its config + worker).",
	"  /chat-thread <name> --parent=<a/b>   Specify parent channel when no pi-chat context is connected.",
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
	const status = entry.endedAt ? `ended at ${entry.endedAt}` : workerAlive ? "active, worker running" : "active, worker stopped";
	return `- ${entry.name}  [${entry.normalizedName}]  ${status}\n    conversation: ${entry.threadConversationId}\n    thread id: ${entry.threadId}`;
}

async function chatThreadList(parent: ResolvedConversation): Promise<string> {
	const catalog = await readCatalog();
	const entries = listForParent(catalog, parent.conversationId);
	if (entries.length === 0) return `No managed threads for ${parent.conversationId}.`;
	const lines = [`Managed threads for ${parent.conversationId}:`];
	for (const entry of entries) {
		const alive = entry.endedAt ? false : isWorkerAlive(entry.threadConversationId);
		lines.push(describeThread(entry, alive));
	}
	return lines.join("\n");
}

interface CreateResult {
	message: string;
	threadConversationId: string;
}

async function chatThreadCreateOrAttach(
	rawName: string,
	parent: ResolvedConversation,
	ctx: ExtensionContext,
	options: { reactivate?: boolean },
): Promise<CreateResult> {
	const normalizedName = normalizeThreadName(rawName);
	if (!normalizedName) throw new Error("Thread name must contain alphanumeric characters.");

	const catalog = await readCatalog();
	const existing = findByName(catalog, parent.conversationId, normalizedName);
	const config = await loadChatConfig();

	if (existing) {
		if (existing.endedAt && !options.reactivate) {
			throw new Error(`Thread '${existing.name}' was ended at ${existing.endedAt}. Rerun with --reactivate to revive it, or choose a new name.`);
		}
		const sessionFile = existing.lastSessionFile ?? (await findMostRecentWorkerSession(existing.threadConversationId));
		if (!sessionFile) throw new Error(`No saved session file for thread '${existing.name}'; cannot restart worker.`);
		const start = startWorker({ conversationId: existing.threadConversationId, sessionFile, cwd: ctx.cwd });
		if (options.reactivate || existing.endedAt) {
			existing.endedAt = null;
		}
		existing.lastSessionFile = sessionFile;
		upsertEntry(catalog, existing);
		await writeCatalog(catalog);
		const action = start.action === "already-running" ? "worker already running" : start.action === "restarted" ? "worker restarted" : "worker started";
		return {
			threadConversationId: existing.threadConversationId,
			message: [
				`Attached to thread: ${existing.name}`,
				`  conversation: ${existing.threadConversationId}`,
				`  thread id: ${existing.threadId}`,
				`  status: ${action} (${start.tmuxName})`,
				`  session: ${sessionFile}`,
			].join("\n"),
		};
	}

	// Fresh thread.
	const sourceSessionFile = ctx.sessionManager.getSessionFile() ?? (await findMostRecentWorkerSession(parent.conversationId));
	if (!sourceSessionFile) throw new Error("No source pi session found to fork. Send a message in the parent channel first, or run /chat-thread from a persisted pi session.");

	const created = await createDiscordThread({ account: parent.account, parentChannelId: parent.channel.id, name: rawName.slice(0, 90) });
	const thread = addThreadConversation({
		config,
		parent,
		threadId: created.id,
		threadName: created.name,
		sessionId: ctx.sessionManager.getSessionId(),
	});
	await saveChatConfig(config);
	const mountInheritance = await inheritMounts(parent.conversationId, thread.conversationId);

	const state: ThreadState = {
		parentConversationId: parent.conversationId,
		threadConversationId: thread.conversationId,
		threadId: created.id,
		threadName: created.name,
		createdAt: new Date().toISOString(),
	};
	(ctx.sessionManager as unknown as { appendCustomEntry(type: string, data: unknown): void }).appendCustomEntry("pi-ez-chat-thread", state);
	const forked = await forkSessionForThread({ sourceSessionFile, thread, threadState: state });
	const start = startWorker({ conversationId: thread.conversationId, sessionFile: forked, cwd: ctx.cwd });

	const entry: ThreadCatalogEntry = {
		parentConversationId: parent.conversationId,
		threadConversationId: thread.conversationId,
		threadId: created.id,
		name: created.name,
		normalizedName,
		createdAt: state.createdAt,
		endedAt: null,
		ownerSessionId: ctx.sessionManager.getSessionId(),
		lastSessionFile: forked,
	};
	upsertEntry(catalog, entry);
	await writeCatalog(catalog);

	await sendDiscordThreadIntro({
		account: parent.account,
		threadId: created.id,
		content: `Created persistent pi session thread **${created.name}**. Continue here to talk to this session.`,
	});

	return {
		threadConversationId: thread.conversationId,
		message: [
			`Created persistent pi thread: ${created.name}`,
			`  parent: ${parent.conversationId}`,
			`  conversation: ${thread.conversationId}`,
			`  thread id: ${created.id}`,
			`  inherited mounts: ${mountInheritance.inherited.length > 0 ? mountInheritance.inherited.join(", ") : "none (run /chat-mount in the parent channel before creating threads if you want host repos available)"}`,
			`  source session: ${sourceSessionFile}`,
			`  forked session: ${forked}`,
			`  worker: ${start.action} (${start.tmuxName})`,
			``,
			`Main-channel /chat-connect changes will not affect this thread; it now has its own continuous worker/session.`,
		].join("\n"),
	};
}

async function chatThreadEnd(
	target: { name?: string },
	parent: ResolvedConversation | undefined,
	currentThread: ThreadState | undefined,
): Promise<string> {
	const catalog = await readCatalog();
	let entry: ThreadCatalogEntry | undefined;

	if (target.name) {
		if (!parent) throw new Error("Specify --parent=<account/channel> or run from a channel with a connected parent.");
		entry = findByName(catalog, parent.conversationId, normalizeThreadName(target.name));
		if (!entry) throw new Error(`No managed thread named '${target.name}' under ${parent.conversationId}.`);
	} else {
		if (!currentThread) throw new Error("Not inside a managed thread. Run /chat-thread end <name> from the parent channel, or omit name from inside the thread.");
		entry = findByThreadConversationId(catalog, currentThread.threadConversationId);
		if (!entry) throw new Error(`Current thread is not in the catalog (${currentThread.threadConversationId}); cannot mark ended.`);
	}

	const killed = killWorker(entry.threadConversationId);
	if (!entry.endedAt) entry.endedAt = new Date().toISOString();
	upsertEntry(catalog, entry);
	await writeCatalog(catalog);

	return [
		`Ended thread: ${entry.name}`,
		`  conversation: ${entry.threadConversationId}`,
		`  worker: ${killed ? "killed" : "was not running"}`,
		`  ended at: ${entry.endedAt}`,
		`  session file kept: ${entry.lastSessionFile ?? "(none recorded)"}`,
		``,
		`The Discord thread itself is not archived. Reactivate later with /chat-thread ${entry.name} --reactivate from the parent channel.`,
	].join("\n");
}

async function dispatch(raw: string, ctx: ExtensionContext, options: { remote?: boolean } = {}): Promise<string> {
	const sub = parseSubcommand(raw);
	if (sub.kind === "help") return USAGE;

	const entries = ctx.sessionManager.getEntries();
	const connectedConversationId = getCurrentPiChatConversationId(entries);
	const currentThread = getCurrentThreadState(entries);

	if (sub.kind === "list") {
		const config = await loadChatConfig();
		// When inside a thread, list under the thread's parent.
		const fallbackParent = currentThread?.parentConversationId;
		const parent = await resolveParent(config, sub.parentConversationId ?? fallbackParent, connectedConversationId);
		return chatThreadList(parent);
	}

	if (sub.kind === "end") {
		const config = await loadChatConfig();
		const parentId = sub.parentConversationId ?? currentThread?.parentConversationId ?? connectedConversationId;
		const parent = parentId ? resolveConversation(config, parentId) : undefined;
		return chatThreadEnd({ name: sub.name }, parent, currentThread);
	}

	// create-or-attach
	if (currentThread) throw new Error("Already inside a managed thread. Run /chat-thread end first, or run /chat-thread <name> from the parent channel.");
	const config = await loadChatConfig();
	const parent = await resolveParent(config, sub.parentConversationId, connectedConversationId);
	assertCanForkFromParent(parent);
	const result = await chatThreadCreateOrAttach(sub.name!, parent, ctx, { reactivate: sub.reactivate });
	void options;
	return result.message;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("chat-thread", {
		description: "Create/attach/end persistent Discord-thread-backed pi-chat sessions",
		handler: async (raw, ctx) => {
			try {
				ctx.ui.notify(await dispatch(raw, ctx), "info");
			} catch (err) {
				ctx.ui.notify(`${(err as Error).message}\n\n${USAGE}`, "error");
			}
		},
	});

	pi.on("input", async (event, ctx) => {
		const match = matchSlashCommand(event.text, ["chat-thread", "chat-ez-thread"]);
		if (!match) return { action: "continue" };
		try {
			const result = await dispatch(match.args, ctx, { remote: true });
			return {
				action: "transform",
				text: `The remote /chat-thread command completed. Reply to the user with this result exactly:\n\n${result}`,
			};
		} catch (err) {
			return {
				action: "transform",
				text: `The remote /chat-thread command failed. Reply to the user with this error and usage:\n\n${(err as Error).message}\n\n${USAGE}`,
			};
		}
	});
}
