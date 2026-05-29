import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extension, { assertCanForkFromParent, canPrompt, parseSubcommand } from "./index.js";
import { addThreadConversation, listDiscordParentConversations, type ChatConfig, type ResolvedConversation } from "./src/chat.js";
import { findByName, listForParent, normalizeThreadName, readCatalog, upsertEntry, writeCatalog, type ThreadCatalogEntry } from "./src/catalog.js";
import { createDiscordThread } from "./src/discord.js";
import { inheritMounts, readMountsConfig, writeMountsConfig } from "./src/mounts.js";
import { matchSlashCommand, normalizeRemoteCommandText, stripLeadingMention } from "./src/match.js";
import {
	forkSessionForThread,
	findMostRecentWorkerSession,
	getCurrentPiChatConversationId,
	getCurrentThreadState,
	type ThreadState,
} from "./src/session.js";
import { buildWorkerCommand, startWorker } from "./src/worker.js";

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
		check("remote input hook is callable", !!inputHandler);

		// Mention/transcript matcher coverage stays in pi-ez-lib but we still smoke-test it here.
		check("remote matcher strips simple mentions", stripLeadingMention("@bot /chat-thread hi") === "/chat-thread hi");
		check("remote matcher strips Discord mentions", matchSlashCommand("<@123> /chat-thread hi", ["chat-thread"])?.args === "hi");
		check("remote matcher strips trailing Discord mentions", matchSlashCommand("/chat-thread hi <@123>", ["chat-thread"])?.args === "hi");
		check("remote matcher handles transcript-shaped commands", matchSlashCommand("- [t] [uid:1] u: <@1> /chat-thread foo", ["chat-thread"])?.args === "foo");
		check("remote normalizer keeps plain text", normalizeRemoteCommandText("- [t] [uid:1] u: hello") === "hello");
		check("remote chat-thread forces non-interactive mode", !canPrompt({ hasUI: true } as any, true));

		// Subcommand parser
		check("parser rejects empty input", parseSubcommand("").kind === "help");
		check("parser treats bare name as create", parseSubcommand("Fix login").kind === "create");
		check("parser captures create name", parseSubcommand("Fix login").name === "Fix login");
		check("parser supports end", parseSubcommand("end").kind === "end" && parseSubcommand("end").name === undefined);
		check("parser supports end <name>", (() => { const s = parseSubcommand("end Fix login"); return s.kind === "end" && s.name === "Fix login"; })());
		check("parser supports list alias", parseSubcommand("ls").kind === "list");
		check("parser supports --reactivate", (() => { const s = parseSubcommand("Fix login --reactivate"); return s.kind === "create" && s.reactivate === true; })());
		check("parser supports --parent", (() => { const s = parseSubcommand("Fix login --parent=acct/main"); return s.kind === "create" && s.parentConversationId === "acct/main"; })());

		// Name normalization
		check("normalizeThreadName collapses spaces and case", normalizeThreadName("  Fix Login Tests!! ") === "fix-login-tests");
		check("normalizeThreadName preserves dots/underscores", normalizeThreadName("v1.2_alpha") === "v1.2_alpha");
		check("normalizeThreadName empty for symbols-only", normalizeThreadName("!!!") === "");

		const parent = fakeConversation(work, "main", "parent-channel-id");
		const config: ChatConfig = { accounts: { acct: { ...parent.account, channels: { main: parent.channel } } } };
		const thread = addThreadConversation({ config, parent, threadId: "1234567890", threadName: "feature idea", sessionId: "sess1" });
		check("thread conversation is added", !!config.accounts.acct.channels[thread.channelKey]);
		check("thread keeps parent channel id", thread.channel.parentChannelId === "parent-channel-id");
		const parents = listDiscordParentConversations(config);
		check("parent picker includes normal Discord channel", parents.some((c) => c.conversationId === parent.conversationId));
		check("parent picker excludes managed threads", !parents.some((c) => c.conversationId === thread.conversationId));

		// Catalog round-trip
		const catalogPath = join(work, "catalog.json");
		await writeCatalog({ version: 1, threads: {} }, catalogPath);
		const empty = await readCatalog(catalogPath);
		check("empty catalog reads", Object.keys(empty.threads).length === 0);
		const entry: ThreadCatalogEntry = {
			parentConversationId: parent.conversationId,
			threadConversationId: thread.conversationId,
			threadId: "1234567890",
			name: "Feature Idea",
			normalizedName: normalizeThreadName("Feature Idea"),
			createdAt: "2026-01-01T00:00:00.000Z",
			endedAt: null,
			ownerSessionId: "sess1",
			lastSessionFile: "/tmp/x.jsonl",
		};
		await writeCatalog(upsertEntry({ version: 1, threads: {} }, entry), catalogPath);
		const readBack = await readCatalog(catalogPath);
		check("catalog upsert+read", readBack.threads[thread.conversationId]?.normalizedName === "feature-idea");
		check("catalog findByName works", findByName(readBack, parent.conversationId, "feature-idea")?.threadConversationId === thread.conversationId);
		check("catalog listForParent works", listForParent(readBack, parent.conversationId).length === 1);

		// Mount inheritance
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

		let managedRejected = false;
		try { assertCanForkFromParent({ channel: { ...thread.channel, managedBy: "pi-ez-chat-threads" } }); } catch { managedRejected = true; }
		check("managed-thread parent is rejected", managedRejected);

		const entries: any[] = [
			{ type: "custom", customType: "pi-chat-state", data: { conversationId: "acct/main" } },
			{ type: "custom", customType: "pi-ez-chat-thread", data: { parentConversationId: "acct/main", threadConversationId: thread.conversationId, threadId: "123", threadName: "t", createdAt: "now" } },
		];
		check("current pi-chat conversation found", getCurrentPiChatConversationId(entries) === "acct/main");
		check("current thread state found", getCurrentThreadState(entries)?.threadConversationId === thread.conversationId);

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
		const recentWorker = await findMostRecentWorkerSession(thread.conversationId);
		check("worker session finder returns most recent", recentWorker === forked, recentWorker);

		// Worker command shape
		const cmd = buildWorkerCommand("/tmp/sess.jsonl", "/tmp/sdir", "acct/thread", ["node", "pi", "-e", "/pkg"]);
		check("worker command passes chat conversation", cmd.includes("--chat-conversation 'acct/thread'"), cmd);
		check("worker command carries explicit extension", cmd.includes("-e '/pkg'"), cmd);

		// startWorker behavior (mocked tmux)
		let tmuxCalls: any[] = [];
		let alive = false;
		const fakeSpawn = ((command: string, args: readonly string[]) => {
			tmuxCalls.push([command, [...args]]);
			if (args[0] === "has-session") return { status: alive ? 0 : 1 } as any;
			if (args[0] === "new-session") { alive = true; return { status: 0 } as any; }
			if (args[0] === "kill-session") { alive = false; return { status: 0 } as any; }
			return { status: 0 } as any;
		}) as any;
		const first = startWorker({ conversationId: "acct/thread", sessionFile: "/tmp/sdir/sess.jsonl", cwd: "/repo", spawn: fakeSpawn });
		check("first startWorker starts tmux", first.action === "started" && tmuxCalls.some((c) => c[1][0] === "new-session"));
		tmuxCalls = [];
		const second = startWorker({ conversationId: "acct/thread", sessionFile: "/tmp/sdir/sess.jsonl", cwd: "/repo", spawn: fakeSpawn });
		check("second startWorker reports already-running", second.action === "already-running" && !tmuxCalls.some((c) => c[1][0] === "new-session"));
		tmuxCalls = [];
		const third = startWorker({ conversationId: "acct/thread", sessionFile: "/tmp/sdir/sess.jsonl", cwd: "/repo", spawn: fakeSpawn, restart: true });
		check("startWorker --restart kills and respawns", third.action === "restarted" && tmuxCalls.some((c) => c[1][0] === "kill-session") && tmuxCalls.some((c) => c[1][0] === "new-session"));
	} finally {
		await rm(work, { recursive: true, force: true });
	}

	const passed = results.filter((r) => r.ok).length;
	for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.details ? ` [${r.details}]` : ""}`);
	console.log(`\n${passed}/${results.length} passed`);
	process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
