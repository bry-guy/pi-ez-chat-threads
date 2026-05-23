import { execFile, spawnSync } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { PI_CHAT_STATE_TYPE, THREAD_STATE_TYPE, tmuxSafeName, type ResolvedConversation } from "./chat.js";

const execFileP = promisify(execFile);

export interface ThreadState {
	parentConversationId: string;
	threadConversationId: string;
	threadId: string;
	threadName: string;
	createdAt: string;
}

export function getCurrentPiChatConversationId(entries: SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== PI_CHAT_STATE_TYPE) continue;
		const id = (entry.data as { conversationId?: unknown } | undefined)?.conversationId;
		if (typeof id === "string" && id.trim()) return id.trim();
	}
	return undefined;
}

export function getExistingThreadState(entries: SessionEntry[], parentConversationId?: string): ThreadState | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== THREAD_STATE_TYPE) continue;
		const data = entry.data as Partial<ThreadState> | undefined;
		if (!data?.threadConversationId || !data.threadId || !data.threadName) continue;
		if (parentConversationId && data.parentConversationId !== parentConversationId) continue;
		return data as ThreadState;
	}
	return undefined;
}

export function defaultThreadName(session: Pick<SessionManager, "getSessionName" | "getSessionId">): string {
	const explicit = session.getSessionName()?.trim();
	if (explicit) return explicit.slice(0, 90);
	return `pi ${session.getSessionId().slice(0, 8)}`;
}

export async function seedThreadWorkspace(parent: ResolvedConversation, thread: ResolvedConversation): Promise<number> {
	await mkdir(thread.workspaceDir, { recursive: true });
	const existing = await readdir(thread.workspaceDir).catch(() => []);
	const userContent = existing.filter((name) => name !== "memory.md" && name !== "skills" && name !== "incoming");
	if (userContent.length === 0) {
		await mkdir(parent.workspaceDir, { recursive: true });
		await execFileP("cp", ["-a", `${parent.workspaceDir}/.`, thread.workspaceDir]);
	}
	return countFiles(thread.workspaceDir);
}

export async function forkSessionForThread(params: {
	sourceSessionFile: string;
	thread: ResolvedConversation;
	threadState: ThreadState;
}): Promise<string> {
	const info = await stat(params.sourceSessionFile).catch(() => undefined);
	if (!info?.isFile()) throw new Error(`No persisted current pi session found: ${params.sourceSessionFile}`);
	const sessionDir = join(params.thread.accountDir, "..", "..", "tmux-sessions", tmuxSafeName(params.thread.conversationId));
	// Resolve via string layout pi-chat uses: ~/.pi/agent/chat/tmux-sessions/<tmux-name>
	const realSessionDir = join(params.thread.accountDir, "..", "..", "tmux-sessions", tmuxSafeName(params.thread.conversationId));
	await mkdir(realSessionDir, { recursive: true });
	void sessionDir;
	const sm = SessionManager.forkFrom(params.sourceSessionFile, params.thread.workspaceDir, realSessionDir);
	const file = sm.getSessionFile();
	if (!file) throw new Error("Session fork did not produce a file");
	sm.appendCustomEntry(PI_CHAT_STATE_TYPE, { conversationId: params.thread.conversationId });
	sm.appendCustomEntry(THREAD_STATE_TYPE, params.threadState);
	sm.appendSessionInfo(`pi-chat ${params.thread.channel.name ?? params.thread.channelKey}`);
	return file;
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function explicitExtensionCommandParts(argv = process.argv): string[] {
	const parts: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if ((arg === "-e" || arg === "--extension") && argv[i + 1]) parts.push(arg, shellQuote(argv[++i]));
		else if (arg.startsWith("--extension=")) parts.push("--extension", shellQuote(arg.slice("--extension=".length)));
	}
	return parts;
}

export function buildWorkerCommand(sessionFile: string, sessionDir: string, conversationId: string, argv = process.argv): string {
	return [
		"exec pi",
		"--session",
		shellQuote(sessionFile),
		"--session-dir",
		shellQuote(sessionDir),
		...explicitExtensionCommandParts(argv),
		"--chat-conversation",
		shellQuote(conversationId),
	].join(" ");
}

export function spawnThreadWorker(params: {
	conversationId: string;
	sessionFile: string;
	cwd: string;
	restart?: boolean;
	spawn?: typeof spawnSync;
}): string {
	const spawn = params.spawn ?? spawnSync;
	const tmuxName = tmuxSafeName(params.conversationId);
	const has = spawn("tmux", ["has-session", "-t", tmuxName], { stdio: "ignore" }).status === 0;
	if (has && !params.restart) return `already running (${tmuxName})`;
	if (has && params.restart) spawn("tmux", ["kill-session", "-t", tmuxName], { stdio: "ignore" });
	const sessionDir = params.sessionFile.replace(/\/[^/]+$/, "");
	const command = buildWorkerCommand(params.sessionFile, sessionDir, params.conversationId);
	const result = spawn("tmux", ["new-session", "-d", "-s", tmuxName, "-c", params.cwd, command], { encoding: "utf8" });
	if (result.error || result.status !== 0) throw new Error(result.stderr?.toString().trim() || result.error?.message || "tmux failed");
	return `started (${tmuxName})`;
}

async function countFiles(dir: string): Promise<number> {
	let count = 0;
	async function walk(current: string): Promise<void> {
		for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
			if (entry.isDirectory()) await walk(join(current, entry.name));
			else count++;
		}
	}
	await walk(dir);
	return count;
}

export async function resetDir(path: string): Promise<void> {
	await rm(path, { recursive: true, force: true });
}
