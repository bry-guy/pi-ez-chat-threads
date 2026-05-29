import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extension, { assertCanForkFromParent, canPrompt, parseSubcommand } from "./index.js";
import { addThreadConversation, listDiscordParentConversations, removeConversation, type ChatConfig, type ResolvedConversation } from "./src/chat.js";
import { findByName, listForParent, normalizeThreadName, readCatalog, removeEntry, upsertEntry, writeCatalog, type ThreadCatalogEntry } from "./src/catalog.js";
import { closeDiscordThread, createDiscordThread, renameDiscordThread } from "./src/discord.js";
import { inheritMounts, readMountsConfig, removeMountsForConversation, writeMountsConfig } from "./src/mounts.js";
import { matchSlashCommand, normalizeRemoteCommandText, stripLeadingMention } from "./src/match.js";
import {
	forkSessionForThread,
	findMostRecentWorkerSession,
	getCurrentPiChatConversationId,
	getCurrentThreadState,
	type ThreadState,
} from "./src/session.js";
import { buildWorkerCommand, forwardedPiArgs, startWorker } from "./src/worker.js";

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
		check("parser rejects empty input", parseSubcommand("").verb === "help");
		check("parser treats bare name as start shorthand", parseSubcommand("Fix login").verb === "start");
		check("parser captures start name from shorthand", parseSubcommand("Fix login").name === "Fix login");
		check("parser supports start <name>", (() => { const s = parseSubcommand("start Fix login"); return s.verb === "start" && s.name === "Fix login"; })());
		check("parser supports stop", parseSubcommand("stop").verb === "stop" && parseSubcommand("stop").name === undefined);
		check("parser supports stop <name>", (() => { const s = parseSubcommand("stop Fix login"); return s.verb === "stop" && s.name === "Fix login"; })());
		check("parser supports restart <name>", (() => { const s = parseSubcommand("restart Fix login"); return s.verb === "restart" && s.name === "Fix login"; })());
		check("parser supports restart with no name", parseSubcommand("restart").verb === "restart");
		check("parser supports kill <name>", (() => { const s = parseSubcommand("kill Fix login"); return s.verb === "kill" && s.name === "Fix login"; })());
		check("parser supports kill with no name", parseSubcommand("kill").verb === "kill");
		check("parser supports rename <target> <name>", (() => { const s = parseSubcommand("rename old-name New Name"); return s.verb === "rename" && s.name === "old-name" && s.newName === "New Name"; })());
		check("parser supports list alias", parseSubcommand("ls").verb === "list");
		check("parser supports --parent on bare-name shorthand", (() => { const s = parseSubcommand("Fix login --parent=acct/main"); return s.verb === "start" && s.parentConversationId === "acct/main"; })());
		check("parser supports --parent on explicit verb", (() => { const s = parseSubcommand("start Fix login --parent=acct/main"); return s.verb === "start" && s.parentConversationId === "acct/main"; })());

		// Name normalization
		check("normalizeThreadName collapses spaces and case", normalizeThreadName("  Fix Login Tests!! ") === "fix-login-tests");
		check("normalizeThreadName preserves dots/underscores", normalizeThreadName("v1.2_alpha") === "v1.2_alpha");
		check("normalizeThreadName empty for symbols-only", normalizeThreadName("!!!") === "");

		const parent = fakeConversation(work, "main", "parent-channel-id");
		(parent.channel as any).gondolin = { image: "custom-image" };
		(parent.channel as any).customFutureField = { enabled: true };
		const config: ChatConfig = { accounts: { acct: { ...parent.account, channels: { main: parent.channel } } } };
		const thread = addThreadConversation({ config, parent, threadId: "1234567890", threadName: "feature idea", sessionId: "sess1" });
		check("thread conversation is added", !!config.accounts.acct.channels[thread.channelKey]);
		check("thread keeps parent channel id", thread.channel.parentChannelId === "parent-channel-id");
		check("thread inherits parent gondolin config", (thread.channel.gondolin as any)?.image === "custom-image");
		check("thread preserves unknown parent channel fields", (thread.channel as any).customFutureField?.enabled === true);
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
			stoppedAt: null,
			ownerSessionId: "sess1",
			lastSessionFile: "/tmp/x.jsonl",
		};
		await writeCatalog(upsertEntry({ version: 1, threads: {} }, entry), catalogPath);
		const readBack = await readCatalog(catalogPath);
		check("catalog upsert+read", readBack.threads[thread.conversationId]?.normalizedName === "feature-idea");
		check("catalog findByName works", findByName(readBack, parent.conversationId, "feature-idea")?.threadConversationId === thread.conversationId);
		check("catalog listForParent works", listForParent(readBack, parent.conversationId).length === 1);
		check("catalog removeEntry works", (() => { const copy = { version: 1 as const, threads: { ...readBack.threads } }; return removeEntry(copy, thread.conversationId) && !copy.threads[thread.conversationId]; })());
		check("chat config removeConversation works", removeConversation(config, thread.conversationId) && !config.accounts.acct.channels[thread.channelKey]);

		// Legacy catalog migration: endedAt -> stoppedAt
		const legacyCatalogPath = join(work, "legacy-catalog.json");
		await writeFile(legacyCatalogPath, JSON.stringify({
			version: 1,
			threads: {
				[thread.conversationId]: {
					parentConversationId: parent.conversationId,
					threadConversationId: thread.conversationId,
					threadId: "1234567890",
					name: "Old",
					normalizedName: "old",
					createdAt: "2026-01-01T00:00:00.000Z",
					endedAt: "2026-01-02T00:00:00.000Z",
					ownerSessionId: "sess1",
					lastSessionFile: "/tmp/x.jsonl",
				},
			},
		}), "utf8");
		const migrated = await readCatalog(legacyCatalogPath);
		check("legacy endedAt migrates to stoppedAt", migrated.threads[thread.conversationId]?.stoppedAt === "2026-01-02T00:00:00.000Z");

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
		check("mount remove deletes thread entry", await removeMountsForConversation(thread.conversationId, mountsPath));
		mounts = await readMountsConfig(mountsPath);
		check("mount remove keeps parent entry", !!mounts[parent.conversationId] && !mounts[thread.conversationId]);

		let managedRejected = false;
		try { assertCanForkFromParent({ channel: { ...thread.channel, managedBy: "pi-ez-chat-threads" } }); } catch { managedRejected = true; }
		check("managed-thread parent is rejected", managedRejected);

		const parentEntries: any[] = [
			{ type: "custom", customType: "pi-chat-state", data: { conversationId: "acct/main" } },
			{ type: "custom", customType: "pi-ez-chat-thread", data: { parentConversationId: "acct/main", threadConversationId: thread.conversationId, threadId: "123", threadName: "t", createdAt: "now" } },
		];
		check("current pi-chat conversation found", getCurrentPiChatConversationId(parentEntries) === "acct/main");
		// Regression: stale pi-ez-chat-thread entries in a parent session must NOT be read
		// as "we are inside a managed thread". The parent session's pi-chat-state points at the
		// parent, not the thread, so the thread entry should be ignored here.
		check("stale thread entry in parent session is ignored", getCurrentThreadState(parentEntries) === undefined);

		const threadEntries: any[] = [
			{ type: "custom", customType: "pi-chat-state", data: { conversationId: thread.conversationId } },
			{ type: "custom", customType: "pi-ez-chat-thread", data: { parentConversationId: "acct/main", threadConversationId: thread.conversationId, threadId: "123", threadName: "t", createdAt: "now" } },
		];
		check("current thread state found when inside the thread", getCurrentThreadState(threadEntries)?.threadConversationId === thread.conversationId);

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
		let renameRequested = "";
		await renameDiscordThread({
			account: parent.account,
			threadId: "thread-id",
			name: "Renamed Thread",
			fetchImpl: (async (url: any, init: any) => {
				renameRequested = String(url);
				const body = JSON.parse(init.body);
				check("discord rename sends name", body.name === "Renamed Thread");
				return { ok: true, status: 200, json: async () => ({}) } as Response;
			}) as typeof fetch,
		});
		check("discord rename endpoint targets thread channel", renameRequested.endsWith("/channels/thread-id"));
		let closeRequested = "";
		await closeDiscordThread({
			account: parent.account,
			threadId: "thread-id",
			fetchImpl: (async (url: any, init: any) => {
				closeRequested = String(url);
				const body = JSON.parse(init.body);
				check("discord close archives thread", body.archived === true);
				check("discord close locks thread", body.locked === true);
				return { ok: true, status: 200, json: async () => ({}) } as Response;
			}) as typeof fetch,
		});
		check("discord close endpoint targets thread channel", closeRequested.endsWith("/channels/thread-id"));

		const fakeSession = join(work, "host.jsonl");
		const header = { type: "session", version: 3, id: "host", timestamp: "2026-01-01T00:00:00.000Z", cwd: parent.workspaceDir };
		const user = { type: "message", id: "u", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } };
		const assistant = { type: "message", id: "a", parentId: "u", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } };
		await writeFile(fakeSession, [header, user, assistant].map((x) => JSON.stringify(x)).join("\n") + "\n");
		const state: ThreadState = { parentConversationId: parent.conversationId, threadConversationId: thread.conversationId, threadId: "1234567890", threadName: "feature idea", createdAt: "now" };
		const forked = await forkSessionForThread({ sourceSessionFile: fakeSession, thread, threadState: state, workerCwd: work });
		const forkedText = await readFile(forked, "utf8");
		check("forked session contains pi-chat binding", forkedText.includes('"customType":"pi-chat-state"'));
		check("forked session contains thread binding", forkedText.includes('"customType":"pi-ez-chat-thread"'));
		const recentWorker = await findMostRecentWorkerSession(thread.conversationId);
		check("worker session finder returns most recent", recentWorker === forked, recentWorker);

		// Worker command shape
		const forwarded = forwardedPiArgs(["node", "pi", "--image", "custom", "--session", "old.jsonl", "--session-dir=/old", "--chat-conversation", "acct/main", "-e", "/pkg"]);
		check("worker arg forwarding keeps runtime args", forwarded.join(" ") === "--image custom -e /pkg", forwarded.join(" "));
		const cmd = buildWorkerCommand("/tmp/sess.jsonl", "/tmp/sdir", "acct/thread", ["node", "pi", "--image", "custom", "--session", "old.jsonl", "-e", "/pkg"]);
		check("worker command passes chat conversation", cmd.includes("--chat-conversation 'acct/thread'"), cmd);
		check("worker command carries explicit extension", cmd.includes("-e '/pkg'"), cmd);
		check("worker command carries image-like runtime args", cmd.includes("--image 'custom'"), cmd);
		check("worker command replaces old session", !cmd.includes("old.jsonl"), cmd);

		// startWorker behavior (mocked tmux)
		let tmuxCalls: any[] = [];
		let alive = false;
		const fakeSpawn = ((command: string, args: readonly string[], options?: any) => {
			tmuxCalls.push([command, [...args], options]);
			if (args[0] === "has-session") return { status: alive ? 0 : 1 } as any;
			if (args[0] === "new-session") { alive = true; return { status: 0 } as any; }
			if (args[0] === "kill-session") { alive = false; return { status: 0 } as any; }
			return { status: 0 } as any;
		}) as any;
		const first = startWorker({ conversationId: "acct/thread", sessionFile: "/tmp/sdir/sess.jsonl", cwd: "/repo", spawn: fakeSpawn, env: { GONDOLIN_IMAGE: "custom" } });
		check("first startWorker starts tmux", first.action === "started" && tmuxCalls.some((c) => c[1][0] === "new-session"));
		check("startWorker passes env to tmux client", tmuxCalls.some((c) => c[2]?.env?.GONDOLIN_IMAGE === "custom"));
		check("startWorker seeds tmux session environment", tmuxCalls.some((c) => c[1].includes("GONDOLIN_IMAGE=custom")));
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
