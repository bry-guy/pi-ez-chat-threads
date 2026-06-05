import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CHAT_HOME, tmuxSafeName } from "./chat.js";

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

export interface WorkerStatusStampOptions {
	statusDir?: string;
	now?: Date;
}

interface WorkerStatusFile {
	conversationId?: string;
	conversationName?: string;
	service?: string;
	pid?: number;
	tmuxSession?: string;
	state?: string;
	updatedAt?: string;
	[key: string]: unknown;
}

export function workerStatusPath(conversationId: string, statusDir = join(CHAT_HOME, "worker-status")): string {
	return join(statusDir, `${tmuxSafeName(conversationId)}.json`);
}

function readExistingWorkerStatus(path: string): WorkerStatusFile {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as WorkerStatusFile;
	} catch {
		return {};
	}
}

export function stampWorkerStatus(conversationId: string, state: "dead" | "restarting", options: WorkerStatusStampOptions = {}): void {
	const path = workerStatusPath(conversationId, options.statusDir);
	const tmuxSession = tmuxSafeName(conversationId);
	const existing = readExistingWorkerStatus(path);
	const next: WorkerStatusFile = {
		...existing,
		conversationId: String(existing.conversationId ?? conversationId),
		tmuxSession: String(existing.tmuxSession ?? tmuxSession),
		state,
		pid: state === "dead" ? 0 : typeof existing.pid === "number" ? existing.pid : 0,
		updatedAt: (options.now ?? new Date()).toISOString(),
	};
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, "\t")}\n`, "utf8");
	renameSync(tmp, path);
}

export function killWorker(conversationId: string, spawn: WorkerSpawn = defaultSpawn(), options: WorkerStatusStampOptions = {}): boolean {
	if (!isWorkerAlive(conversationId, spawn)) {
		stampWorkerStatus(conversationId, "dead", options);
		return false;
	}
	const tmuxName = tmuxSafeName(conversationId);
	const result = spawn("tmux", ["kill-session", "-t", tmuxName], { stdio: "ignore" });
	if (result.status === 0) stampWorkerStatus(conversationId, "dead", options);
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
	statusDir?: string;
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
	if (alive && params.restart) {
		const result = spawn("tmux", ["kill-session", "-t", tmuxName], { stdio: "ignore" });
		if (result.status === 0) stampWorkerStatus(params.conversationId, "restarting", { statusDir: params.statusDir });
	}
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
