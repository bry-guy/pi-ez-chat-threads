import { spawnSync } from "node:child_process";

import { tmuxSafeName } from "./chat.js";

export interface WorkerSpawnOptions {
	stdio?: unknown;
	encoding?: BufferEncoding;
	env?: NodeJS.ProcessEnv;
}

export interface WorkerSpawn {
	(command: string, args: readonly string[], options?: WorkerSpawnOptions): {
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

const REPLACED_VALUE_FLAGS = new Set(["--session", "--session-dir", "--chat-conversation"]);
const REPLACED_PREFIX_FLAGS = ["--session=", "--session-dir=", "--chat-conversation="];

export function forwardedPiArgs(argv: readonly string[] = process.argv): string[] {
	const raw = argv.slice(2);
	const out: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		const arg = raw[i];
		if (REPLACED_VALUE_FLAGS.has(arg)) {
			i++;
			continue;
		}
		if (REPLACED_PREFIX_FLAGS.some((prefix) => arg.startsWith(prefix))) continue;
		out.push(arg);
	}
	return out;
}

export function buildWorkerCommand(sessionFile: string, sessionDir: string, conversationId: string, argv: readonly string[] = process.argv): string {
	return [
		"exec pi",
		...forwardedPiArgs(argv).map(shellQuote),
		"--session",
		shellQuote(sessionFile),
		"--session-dir",
		shellQuote(sessionDir),
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
	env?: NodeJS.ProcessEnv;
}

export interface WorkerStartResult {
	action: "already-running" | "started" | "restarted";
	tmuxName: string;
}

function tmuxEnvironmentArgs(env: NodeJS.ProcessEnv): string[] {
	return Object.entries(env)
		.filter((entry): entry is [string, string] => typeof entry[1] === "string")
		.flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

export function startWorker(params: WorkerStartParams): WorkerStartResult {
	const spawn = params.spawn ?? defaultSpawn();
	const tmuxName = tmuxSafeName(params.conversationId);
	const alive = isWorkerAlive(params.conversationId, spawn);
	if (alive && !params.restart) return { action: "already-running", tmuxName };
	if (alive && params.restart) spawn("tmux", ["kill-session", "-t", tmuxName], { stdio: "ignore" });
	const sessionDir = params.sessionFile.replace(/\/[^/]+$/, "");
	const command = buildWorkerCommand(params.sessionFile, sessionDir, params.conversationId);
	const env = { ...process.env, ...(params.env ?? {}) };
	const result = spawn("tmux", ["new-session", "-d", ...tmuxEnvironmentArgs(env), "-s", tmuxName, "-c", params.cwd, command], { encoding: "utf8", env });
	if (result.error || result.status !== 0) {
		const stderr = typeof result.stderr === "string" ? result.stderr : result.stderr?.toString() ?? "";
		throw new Error(stderr.trim() || result.error?.message || "tmux failed");
	}
	return { action: alive ? "restarted" : "started", tmuxName };
}
