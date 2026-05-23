import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { addThreadConversation, loadChatConfig, resolveConversation, saveChatConfig } from "./src/chat.js";
import { createDiscordThread, sendDiscordThreadIntro } from "./src/discord.js";
import {
	defaultThreadName,
	forkSessionForThread,
	getCurrentPiChatConversationId,
	getExistingThreadState,
	seedThreadWorkspace,
	spawnThreadWorker,
	type ThreadState,
} from "./src/session.js";

interface Args {
	name?: string;
	newThread: boolean;
	noSpawn: boolean;
	restart: boolean;
}

function tokenize(raw: string): string[] {
	return raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((t) => t.replace(/^["']|["']$/g, "")) ?? [];
}

function parseArgs(raw: string): Args {
	const args: Args = { newThread: false, noSpawn: false, restart: false };
	const name: string[] = [];
	for (const token of tokenize(raw)) {
		if (token === "--new") args.newThread = true;
		else if (token === "--no-spawn") args.noSpawn = true;
		else if (token === "--restart") args.restart = true;
		else if (token.startsWith("-")) throw new Error(`unknown flag: ${token}`);
		else name.push(token);
	}
	args.name = name.join(" ").trim() || undefined;
	return args;
}

const USAGE = `Usage: /chat-thread [thread name] [--new] [--restart] [--no-spawn]

Create a persistent Discord thread for the current pi-chat conversation and fork this pi session into it.
Repeated calls reuse this session's existing thread unless --new is passed.`;

async function createOrReuseThread(raw: string, ctx: ExtensionCommandContext): Promise<string> {
	const args = parseArgs(raw);
	const entries = ctx.sessionManager.getEntries();
	const parentConversationId = getCurrentPiChatConversationId(entries);
	if (!parentConversationId) throw new Error("This pi session is not connected to pi-chat. Run /chat-connect first.");

	const config = await loadChatConfig();
	const parent = resolveConversation(config, parentConversationId);
	if (!parent) throw new Error(`Current pi-chat conversation is no longer configured: ${parentConversationId}`);
	if (parent.service !== "discord") throw new Error("/chat-thread currently supports Discord pi-chat conversations only.");

	const existing = args.newThread ? undefined : getExistingThreadState(entries, parentConversationId);
	if (existing) {
		return [
			`Reusing persistent thread: ${existing.threadName}`,
			`  conversation: ${existing.threadConversationId}`,
			`  thread id: ${existing.threadId}`,
			`Messages in that Discord thread continue the same pi session history.`,
		].join("\n");
	}

	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Current pi session is not persisted. Start pi with sessions enabled before /chat-thread.");

	const threadName = (args.name ?? defaultThreadName(ctx.sessionManager)).slice(0, 90);
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
	const forked = await forkSessionForThread({ sourceSessionFile: sessionFile, thread, threadState: state });
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
		`  forked session: ${forked}`,
		`  worker: ${worker}`,
		``,
		`Main-channel /chat-connect changes will not affect this thread; it now has its own continuous worker/session.`,
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("chat-thread", {
		description: "Create/reuse a persistent Discord thread-backed pi-chat session from the current chat context",
		handler: async (raw, ctx) => {
			try {
				ctx.ui.notify(await createOrReuseThread(raw, ctx), "info");
			} catch (err) {
				ctx.ui.notify(`${(err as Error).message}\n\n${USAGE}`, "error");
			}
		},
	});
}
