import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extension, { assertCanForkFromParent, canPrompt } from "./index.js";
import { addThreadConversation, listDiscordParentConversations, type ChatConfig, type ResolvedConversation } from "./src/chat.js";
import { createDiscordThread } from "./src/discord.js";
import { inheritMounts, readMountsConfig, writeMountsConfig } from "./src/mounts.js";
import { matchSlashCommand, normalizeRemoteCommandText, stripLeadingMention } from "./src/match.js";
import {
	buildWorkerCommand,
	defaultThreadName,
	findMostRecentWorkerSession,
	forkSessionForThread,
	getCurrentPiChatConversationId,
	getExistingThreadState,
	spawnThreadWorker,
	type ThreadState,
} from "./src/session.js";

interface TR { name: string; ok: boolean; details?: string }
const results: TR[] = [];
function check(name: string, ok: boolean, details?: string) { results.push({ name, ok, details }); }

function fakeConversation(root: string, channelKey: string, id: string): ResolvedConversation {
	const accountDir = join(root, "chat", "accounts", "acct");
	const conversationDir = join(accountDir, "channels", channelKey);
	return {
		service: "discord",
		accountId: "acct",
		account: { service: "discord", name: "Discord", channels: {}, botToken: "token", serverId: "guild", serverName: "Guild" },
		channelKey,
		channel: { id, name: channelKey },
		conversationId: `acct/${channelKey}`,
		conversationName: `Discord / ${channelKey}`,
		accountDir,
		sharedDir: join(accountDir, "shared"),
		conversationDir,
		workspaceDir: join(conversationDir, "workspace"),
		channelMemoryPath: join(conversationDir, "workspace", "memory.md"),
	};
}

async function main() {
	const work = await mkdtemp(join(tmpdir(), "pi-ez-chat-threads-test-"));
	try {
		let registered = "";
		let inputHook = false;
		let inputHandler: any;
		extension({
			registerCommand: (name: string) => { registered = name; },
			on: (event: string, handler: any) => { if (event === "input") { inputHook = true; inputHandler = handler; } },
		} as any);
		check("pi extension registers /chat-thread", registered === "chat-thread");
		check("pi extension registers remote input hook", inputHook);
		check("remote input hook ignores normal text", !!inputHandler);
		check("remote matcher strips simple mentions", stripLeadingMention("@bot /chat-thread hi") === "/chat-thread hi");
		check("remote matcher strips Discord mentions", matchSlashCommand("<@123> /chat-thread hi", ["chat-thread"])?.args === "hi");
		check("remote matcher strips trailing Discord mentions", matchSlashCommand("/chat-thread hi <@123>", ["chat-thread"])?.args === "hi");
		check("remote matcher handles transcript-shaped mention commands", matchSlashCommand("- [2026-05-27T12:00:00.000Z] [uid:123] prettybry: <@1496> /chat-thread", ["chat-thread"])?.args === "");
		check("remote matcher handles transcript-shaped trailing mentions", matchSlashCommand("- [2026-05-27T12:00:00.000Z] [uid:123] prettybry: /chat-thread foobar <@1496>", ["chat-thread"])?.args === "foobar");
		check("remote normalizer preserves non-command text after transcript stripping", normalizeRemoteCommandText("- [2026-05-27T12:00:00.000Z] [uid:123] prettybry: hello") === "hello");
		check("remote /chat-thread disables interactive prompts even if UI is present", !canPrompt({ hasUI: true } as any, true));

		const parent = fakeConversation(work, "main", "parent-channel-id");

		const config: ChatConfig = { accounts: { acct: { ...parent.account, channels: { main: parent.channel } } } };
		const thread = addThreadConversation({ config, parent, threadId: "1234567890", threadName: "feature idea", sessionId: "sess1" });
		check("thread conversation is added", !!config.accounts.acct.channels[thread.channelKey]);
		check("thread keeps parent channel id", thread.channel.parentChannelId === "parent-channel-id");
		check("thread key is stable-ish", thread.conversationId.startsWith("acct/feature-idea-"), thread.conversationId);
		const again = addThreadConversation({ config, parent, threadId: "1234567890", threadName: "feature idea renamed", sessionId: "sess1" });
		check("same Discord thread id reuses config entry", again.conversationId === thread.conversationId);
		check("reuse updates name", again.channel.name === "feature idea renamed");
		const parents = listDiscordParentConversations(config);
		check("parent picker includes normal Discord channel", parents.some((c) => c.conversationId === parent.conversationId));
		check("parent picker excludes managed threads", !parents.some((c) => c.conversationId === thread.conversationId));

		const mountsPath = join(work, "chat-mount", "mounts.json");
		await writeMountsConfig({
			[parent.conversationId]: {
				"/repo-main": { hostPath: "/host/repo", mode: "rw" },
				"/docs": { hostPath: "/host/docs", mode: "ro" },
			},
		}, mountsPath);
		const inherited = await inheritMounts(parent.conversationId, thread.conversationId, mountsPath);
		check("mount inheritance reports guest paths", inherited.inherited.join(",") === "/docs,/repo-main", inherited.inherited.join(","));
		let mounts = await readMountsConfig(mountsPath);
		check("mount inheritance writes thread entry", mounts[thread.conversationId]?.["/repo-main"]?.hostPath === "/host/repo");
		const inheritedAgain = await inheritMounts(parent.conversationId, thread.conversationId, mountsPath);
		mounts = await readMountsConfig(mountsPath);
		check("mount inheritance is idempotent", inheritedAgain.inherited.length === 2 && Object.keys(mounts[thread.conversationId] ?? {}).length === 2);
		await writeMountsConfig({
			[parent.conversationId]: { "/other": { hostPath: "/host/other", mode: "rw" } },
			[thread.conversationId]: { "/stale": { hostPath: "/host/stale", mode: "rw" } },
		}, mountsPath);
		await inheritMounts(parent.conversationId, thread.conversationId, mountsPath);
		mounts = await readMountsConfig(mountsPath);
		check("re-running mount inheritance mirrors parent state", !!mounts[thread.conversationId]?.["/other"] && !mounts[thread.conversationId]?.["/stale"]);
		const missingInherited = await inheritMounts("acct/missing", thread.conversationId, join(work, "missing", "mounts.json"));
		check("missing mounts file inherits none", missingInherited.inherited.length === 0);

		let managedRejected = false;
		try { assertCanForkFromParent({ channel: { ...thread.channel, managedBy: "pi-ez-chat-threads" } }); } catch { managedRejected = true; }
		check("managed-thread parent is rejected", managedRejected);

		const entries: any[] = [
			{ type: "custom", customType: "pi-chat-state", data: { conversationId: "acct/main" } },
			{ type: "custom", customType: "pi-ez-chat-thread", data: { parentConversationId: "acct/main", threadConversationId: thread.conversationId, threadId: "123", threadName: "t", createdAt: "now" } },
		];
		check("current pi-chat conversation found", getCurrentPiChatConversationId(entries) === "acct/main");
		check("existing thread state found", getExistingThreadState(entries, "acct/main")?.threadConversationId === thread.conversationId);
		check("existing thread state scoped by parent", getExistingThreadState(entries, "acct/other") === undefined);
		check("default thread name uses session name", defaultThreadName({ getSessionName: () => "My Session", getSessionId: () => "abcdef" } as any) === "My Session");

		let requestedUrl = "";
		const created = await createDiscordThread({
			account: parent.account,
			parentChannelId: "parent-channel-id",
			name: "My Session",
			fetchImpl: (async (url: any, init: any) => {
				requestedUrl = String(url);
				const body = JSON.parse(init.body);
				check("discord create uses public thread type", body.type === 11);
				check("discord create uses requested name", body.name === "My Session");
				return { ok: true, status: 200, json: async () => ({ id: "thread-id", name: body.name }) } as Response;
			}) as typeof fetch,
		});
		check("discord API endpoint targets parent channel", requestedUrl.endsWith("/channels/parent-channel-id/threads"));
		check("discord thread result parsed", created.id === "thread-id" && created.name === "My Session");

		const fakeSession = join(work, "host.jsonl");
		const header = { type: "session", version: 3, id: "host", timestamp: "2026-01-01T00:00:00.000Z", cwd: parent.workspaceDir };
		const user = { type: "message", id: "u", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } };
		const assistant = { type: "message", id: "a", parentId: "u", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } };
		await writeFile(fakeSession, [header, user, assistant].map((x) => JSON.stringify(x)).join("\n") + "\n");
		const state: ThreadState = { parentConversationId: parent.conversationId, threadConversationId: thread.conversationId, threadId: "1234567890", threadName: "feature idea", createdAt: "now" };
		const forked = await forkSessionForThread({ sourceSessionFile: fakeSession, thread, threadState: state });
		const forkedText = await readFile(forked, "utf8");
		check("forked session contains pi-chat binding", forkedText.includes('"customType":"pi-chat-state"'));
		check("forked session contains thread binding", forkedText.includes('"customType":"pi-ez-chat-thread"'));
		check("forked session stored under tmux-sessions", forked.includes("tmux-sessions/pi-chat-worker-acct_feature-idea-"), forked);
		const recentWorker = await findMostRecentWorkerSession(thread.conversationId);
		check("parent worker session finder returns most recent", recentWorker === forked, recentWorker);

		const cmd = buildWorkerCommand("/tmp/sess.jsonl", "/tmp/sdir", "acct/thread", ["node", "pi", "-e", "/pkg"]);
		check("worker command passes chat conversation", cmd.includes("--chat-conversation 'acct/thread'"), cmd);
		check("worker command carries explicit extension", cmd.includes("-e '/pkg'"), cmd);
		const calls: any[] = [];
		const msg = spawnThreadWorker({
			conversationId: "acct/thread",
			sessionFile: "/tmp/sdir/sess.jsonl",
			cwd: "/repo",
			spawn: ((cmd: string, args: string[], opts: any) => {
				calls.push([cmd, args, opts]);
				return { status: calls.length === 1 ? 1 : 0, stderr: "" } as any;
			}) as any,
		});
		check("spawn worker starts tmux", msg.includes("started") && calls.some((c) => c[1]?.[0] === "new-session"));
	} finally {
		await rm(work, { recursive: true, force: true });
	}

	const passed = results.filter((r) => r.ok).length;
	for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.details ? ` [${r.details}]` : ""}`);
	console.log(`\n${passed}/${results.length} passed`);
	process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
