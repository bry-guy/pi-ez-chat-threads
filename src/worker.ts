import { spawnSync } from "node:child_process";

import { tmuxSafeName } from "./chat.js";

export interface WorkerSpawn {
	(command: string, args: readonly string[], options?: { stdio?: unknown; encoding?: BufferEncoding }): {
		status: number | null;
		stderr?: string | Buffer;
		error?: Error;
	};
}

function defaultSpawn(): WorkerSpawn {
	return spawnSync as unknown as WorkerSpawn;
}

export function isWorkerAlive(conversationId: string, spawn: WorkerSpawn = defaultSpawn()): boolean {
	const tmuxName = tmuxSafeName(conversationId);
	return spawn("tmux", ["has-session", "-t", tmuxName], { stdio: "ignore" }).status === 0;
}

export function killWorker(conversationId: string, spawn: WorkerSpawn = defaultSpawn()): boolean {
	if (!isWorkerAlive(conversationId, spawn)) return false;
	const tmuxName = tmuxSafeName(conversationId);
	const result = spawn("tmux", ["kill-session", "-t", tmuxName], { stdio: "ignore" });
	return result.status === 0;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function explicitExtensionCommandParts(argv: readonly string[]): string[] {
	const parts: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if ((arg === "-e" || arg === "--extension") && argv[i + 1]) parts.push(arg, shellQuote(argv[++i]));
		else if (arg.startsWith("--extension=")) parts.push("--extension", shellQuote(arg.slice("--extension=".length)));
	}
	return parts;
}

export function buildWorkerCommand(sessionFile: string, sessionDir: string, conversationId: string, argv: readonly string[] = process.argv): string {
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

export interface WorkerStartParams {
	conversationId: string;
	sessionFile: string;
	cwd: string;
	restart?: boolean;
	spawn?: WorkerSpawn;
}

export interface WorkerStartResult {
	action: "already-running" | "started" | "restarted";
	tmuxName: string;
}

export function startWorker(params: WorkerStartParams): WorkerStartResult {
	const spawn = params.spawn ?? defaultSpawn();
	const tmuxName = tmuxSafeName(params.conversationId);
	const alive = isWorkerAlive(params.conversationId, spawn);
	if (alive && !params.restart) return { action: "already-running", tmuxName };
	if (alive && params.restart) spawn("tmux", ["kill-session", "-t", tmuxName], { stdio: "ignore" });
	const sessionDir = params.sessionFile.replace(/\/[^/]+$/, "");
	const command = buildWorkerCommand(params.sessionFile, sessionDir, params.conversationId);
	const result = spawn("tmux", ["new-session", "-d", "-s", tmuxName, "-c", params.cwd, command], { encoding: "utf8" });
	if (result.error || result.status !== 0) {
		const stderr = typeof result.stderr === "string" ? result.stderr : result.stderr?.toString() ?? "";
		throw new Error(stderr.trim() || result.error?.message || "tmux failed");
	}
	return { action: alive ? "restarted" : "started", tmuxName };
}
