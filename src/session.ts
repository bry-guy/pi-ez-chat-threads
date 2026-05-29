import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { CHAT_HOME, PI_CHAT_STATE_TYPE, THREAD_STATE_TYPE, tmuxSafeName, type ResolvedConversation } from "./chat.js";

export interface SourceSessionChoice {
	label: string;
	path: string;
}

export async function findMostRecentWorkerSession(conversationId: string): Promise<string | undefined> {
	const dir = join(CHAT_HOME, "tmux-sessions", tmuxSafeName(conversationId));
	const entries = await readdir(dir).catch(() => []);
	const files = await Promise.all(
		entries
			.filter((name) => name.endsWith(".jsonl"))
			.map(async (name) => {
				const path = join(dir, name);
				const info = await stat(path).catch(() => undefined);
				return info?.isFile() ? { path, mtime: info.mtimeMs } : undefined;
			}),
	);
	return files.filter((f): f is { path: string; mtime: number } => !!f).sort((a, b) => b.mtime - a.mtime)[0]?.path;
}

export async function listSavedSessionsForPicker(limit = 30): Promise<SourceSessionChoice[]> {
	const sessions = await SessionManager.listAll().catch(() => []);
	return sessions.slice(0, limit).map((s) => {
		const title = s.name?.trim() || s.firstMessage.replace(/\s+/g, " ").slice(0, 60) || s.id.slice(0, 8);
		const cwd = s.cwd ? ` — ${s.cwd}` : "";
		return { label: `${title}${cwd}`, path: s.path };
	});
}

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

export function getCurrentThreadState(entries: SessionEntry[]): ThreadState | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== THREAD_STATE_TYPE) continue;
		const data = entry.data as Partial<ThreadState> | undefined;
		if (!data?.threadConversationId || !data.threadId || !data.threadName) continue;
		return data as ThreadState;
	}
	return undefined;
}

export async function forkSessionForThread(params: {
	sourceSessionFile: string;
	thread: ResolvedConversation;
	threadState: ThreadState;
}): Promise<string> {
	const info = await stat(params.sourceSessionFile).catch(() => undefined);
	if (!info?.isFile()) throw new Error(`No persisted current pi session found: ${params.sourceSessionFile}`);
	const realSessionDir = join(params.thread.accountDir, "..", "..", "tmux-sessions", tmuxSafeName(params.thread.conversationId));
	await mkdir(realSessionDir, { recursive: true });
	const sm = SessionManager.forkFrom(params.sourceSessionFile, params.thread.workspaceDir, realSessionDir);
	const file = sm.getSessionFile();
	if (!file) throw new Error("Session fork did not produce a file");
	sm.appendCustomEntry(PI_CHAT_STATE_TYPE, { conversationId: params.thread.conversationId });
	sm.appendCustomEntry(THREAD_STATE_TYPE, params.threadState);
	sm.appendSessionInfo(`pi-chat ${params.thread.channel.name ?? params.thread.channelKey}`);
	return file;
}
