import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { addThreadConversation, listDiscordParentConversations, loadChatConfig, resolveConversation, saveChatConfig, type ResolvedConversation } from "./src/chat.js";
import { createDiscordThread, sendDiscordThreadIntro } from "./src/discord.js";
import {
	defaultThreadName,
	forkSessionForThread,
	findMostRecentWorkerSession,
	getCurrentPiChatConversationId,
	getExistingThreadState,
	listSavedSessionsForPicker,
	seedThreadWorkspace,
	spawnThreadWorker,
	type ThreadState,
} from "./src/session.js";

interface Args {
	name?: string;
	parentConversationId?: string;
	newThread: boolean;
	noSpawn: boolean;
	restart: boolean;
}

function tokenize(raw: string): string[] {
	return raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((t) => t.replace(/^["']|["']$/g, "")) ?? [];
}

function isRemoteContext(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "chat-context");
}

function parseArgs(raw: string): Args {
	const args: Args = { newThread: false, noSpawn: false, restart: false };
	const name: string[] = [];
	for (const token of tokenize(raw)) {
		if (token === "--new") args.newThread = true;
		else if (token === "--no-spawn") args.noSpawn = true;
		else if (token === "--restart") args.restart = true;
		else if (token.startsWith("--parent=")) args.parentConversationId = token.slice("--parent=".length);
		else if (token.startsWith("--channel=")) args.parentConversationId = token.slice("--channel=".length);
		else if (token.startsWith("-")) throw new Error(`unknown flag: ${token}`);
		else name.push(token);
	}
	args.name = name.join(" ").trim() || undefined;
	return args;
}

const USAGE = `Usage: /chat-thread [thread name] [--parent=<account/channel>] [--new] [--restart] [--no-spawn]

Create a persistent Discord thread and fork the current pi session into it.
If this session is connected to pi-chat, that Discord channel is the default parent.
Otherwise pass --parent or choose a configured Discord channel interactively.
Repeated calls reuse this session's existing thread unless --new is passed.`;

async function chooseParentConversation(
	config: Awaited<ReturnType<typeof loadChatConfig>>,
	ctx: ExtensionContext,
	explicitId?: string,
	connectedId?: string,
): Promise<ResolvedConversation> {
	const selectedId = explicitId ?? connectedId;
	if (selectedId) {
		const parent = resolveConversation(config, selectedId);
		if (!parent) throw new Error(`Configured pi-chat conversation not found: ${selectedId}`);
		if (parent.service !== "discord") throw new Error("/chat-thread currently supports Discord parent channels only.");
		return parent;
	}

	const choices = listDiscordParentConversations(config);
	if (choices.length === 0) throw new Error("No configured Discord pi-chat channels. Run /chat-config first.");
	if (!ctx.hasUI) throw new Error("No connected pi-chat context. Pass --parent=<account/channel>.");
	const labels = choices.map((c) => `${c.conversationName}  (${c.conversationId})`);
	const picked = await ctx.ui.select("Create Discord thread under which channel?", labels);
	const idx = labels.indexOf(picked ?? "");
	if (idx < 0) throw new Error("No parent channel selected.");
	return choices[idx];
}

async function chooseSourceSession(
	ctx: ExtensionContext,
	parent: ResolvedConversation,
): Promise<{ path: string; description: string }> {
	const current = ctx.sessionManager.getSessionFile();
	const parentWorker = await findMostRecentWorkerSession(parent.conversationId);

	if (!ctx.hasUI) {
		if (isRemoteContext(ctx) && parentWorker) {
			return { path: parentWorker, description: `parent worker session for ${parent.conversationId}` };
		}
		if (!current) throw new Error("Current pi session is not persisted. Start pi with sessions enabled before /chat-thread.");
		return { path: current, description: "current pi session" };
	}

	const options: string[] = [];
	if (current) options.push(`Use current pi session (default) — ${ctx.sessionManager.getSessionName() ?? ctx.sessionManager.getSessionId().slice(0, 8)}`);
	options.push("Resume/use a different saved pi session...");
	if (parentWorker) options.push(`Use current connected worker session for ${parent.conversationId}`);

	const picked = await ctx.ui.select("Which pi session should this Discord thread continue?", options);
	if (!picked) throw new Error("No source session selected.");
	if (picked.startsWith("Use current pi session")) return { path: current!, description: "current pi session" };
	if (picked.startsWith("Use current connected worker")) return { path: parentWorker!, description: `parent worker session for ${parent.conversationId}` };

	const sessions = await listSavedSessionsForPicker();
	if (sessions.length === 0) throw new Error("No saved pi sessions found to resume.");
	const labels = sessions.map((s) => s.label);
	const selected = await ctx.ui.select("Choose saved pi session to fork into the Discord thread", labels);
	const idx = labels.indexOf(selected ?? "");
	if (idx < 0) throw new Error("No saved pi session selected.");
	return { path: sessions[idx].path, description: sessions[idx].label };
}

async function createOrReuseThread(raw: string, ctx: ExtensionContext): Promise<string> {
	const args = parseArgs(raw);
	const entries = ctx.sessionManager.getEntries();
	const connectedConversationId = getCurrentPiChatConversationId(entries);

	const config = await loadChatConfig();
	const parent = await chooseParentConversation(config, ctx, args.parentConversationId, connectedConversationId);
	const parentConversationId = parent.conversationId;

	const existing = args.newThread ? undefined : getExistingThreadState(entries, parentConversationId);
	if (existing) {
		return [
			`Reusing persistent thread: ${existing.threadName}`,
			`  conversation: ${existing.threadConversationId}`,
			`  thread id: ${existing.threadId}`,
			`Messages in that Discord thread continue the same pi session history.`,
		].join("\n");
	}

	const sourceSession = await chooseSourceSession(ctx, parent);

	const sourceName = (() => {
		try { return SessionManager.open(sourceSession.path).getSessionName(); } catch { return undefined; }
	})();
	const threadName = (args.name ?? sourceName ?? defaultThreadName(ctx.sessionManager)).slice(0, 90);
	const created = await createDiscordThread({ account: parent.account, parentChannelId: parent.channel.id, name: threadName });
	const thread = addThreadConversation({
		config,
		parent,
		threadId: created.id,
		threadName: created.name,
		sessionId: ctx.sessionManager.getSessionId(),
	});
	await saveChatConfig(config);

	const state: ThreadState = {
		parentConversationId,
		threadConversationId: thread.conversationId,
		threadId: created.id,
		threadName: created.name,
		createdAt: new Date().toISOString(),
	};
	(ctx.sessionManager as unknown as { appendCustomEntry(type: string, data: unknown): void }).appendCustomEntry("pi-ez-chat-thread", state);
	const fileCount = await seedThreadWorkspace(parent, thread);
	const forked = await forkSessionForThread({ sourceSessionFile: sourceSession.path, thread, threadState: state });
	let worker = "not spawned (--no-spawn)";
	if (!args.noSpawn) worker = spawnThreadWorker({ conversationId: thread.conversationId, sessionFile: forked, cwd: ctx.cwd, restart: args.restart });

	await sendDiscordThreadIntro({
		account: parent.account,
		threadId: created.id,
		content: `Created persistent pi session thread **${created.name}**. Continue here to talk to this session.`,
	});

	return [
		`Created persistent pi thread: ${created.name}`,
		`  parent: ${parent.conversationId}`,
		`  conversation: ${thread.conversationId}`,
		`  thread id: ${created.id}`,
		`  workspace files: ${fileCount}`,
		`  source session: ${sourceSession.description}`,
		`  forked session: ${forked}`,
		`  worker: ${worker}`,
		``,
		`Main-channel /chat-connect changes will not affect this thread; it now has its own continuous worker/session.`,
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("chat-thread", {
		description: "Create/reuse a persistent Discord thread-backed pi-chat session from the current pi session",
		handler: async (raw, ctx) => {
			try {
				ctx.ui.notify(await createOrReuseThread(raw, ctx), "info");
			} catch (err) {
				ctx.ui.notify(`${(err as Error).message}\n\n${USAGE}`, "error");
			}
		},
	});

	pi.on("input", async (event, ctx) => {
		const text = event.text.trim();
		if (!text.startsWith("/chat-thread") && !text.startsWith("/chat-ez-thread")) return { action: "continue" };
		const raw = text.replace(/^\/(chat-thread|chat-ez-thread)\b/, "").trim();
		try {
			const result = await createOrReuseThread(raw, ctx);
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
