import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { CHAT_HOME, loadChatConfig, resolveConversation, tmuxSafeName, type ChatAccountConfig, type ResolvedConversation } from "./chat.js";
import { listForParent, readCatalog, reconcileCatalogWorkerState, upsertEntry, writeCatalog, type ThreadCatalogEntry } from "./catalog.js";
import { sendDiscordChannelEmbed } from "./discord.js";
import { findMostRecentWorkerSession, getCurrentPiChatConversationId, getCurrentThreadState } from "./session.js";
import { isWorkerAlive, killWorker, startWorker } from "./worker.js";

export interface DiscordMessageSummary {
	id: string;
	timestamp: string;
	authorId?: string;
	authorBot?: boolean;
}

interface DiscordApiMessage {
	id?: string;
	timestamp?: string;
	author?: { id?: string; bot?: boolean };
}

export interface ThreadWorkerStatus {
	sessionFile?: string;
	state?: string;
	updatedAt?: string;
	queueLength?: number;
	hasActiveJob?: boolean;
	chatTurnInFlight?: boolean;
}

export interface SupervisorOptions {
	fetchImpl?: typeof fetch;
	intervalMs?: number;
	idleSuspendMs?: number;
	suspendNotice?: boolean;
}

export interface SupervisorState {
	seenMessageIds: Map<string, string>;
	waking: Set<string>;
}

function numberFromEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw == null || raw.trim() === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (raw == null || raw.trim() === "") return fallback;
	return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

export function compareDiscordSnowflakes(a: string, b: string): number {
	try {
		const aa = BigInt(a);
		const bb = BigInt(b);
		return aa === bb ? 0 : aa > bb ? 1 : -1;
	} catch {
		return a.localeCompare(b);
	}
}

export function latestUserMessage(
	messages: readonly DiscordMessageSummary[],
	botUserId?: string,
): DiscordMessageSummary | undefined {
	return [...messages]
		.filter((message) => !message.authorBot && (!botUserId || message.authorId !== botUserId))
		.sort((a, b) => {
			const byTime = Date.parse(b.timestamp) - Date.parse(a.timestamp);
			return byTime || compareDiscordSnowflakes(b.id, a.id);
		})[0];
}

export function shouldWakeForMessage(params: {
	latest: DiscordMessageSummary | undefined;
	lastSeenId?: string;
	stoppedAt?: string | null;
	workerAlive: boolean;
}): boolean {
	if (params.workerAlive || !params.latest) return false;
	if (params.lastSeenId) return compareDiscordSnowflakes(params.latest.id, params.lastSeenId) > 0;
	if (!params.stoppedAt) return false;
	const latestTs = Date.parse(params.latest.timestamp);
	const stoppedTs = Date.parse(params.stoppedAt);
	return Number.isFinite(latestTs) && Number.isFinite(stoppedTs) && latestTs > stoppedTs;
}

export async function fetchRecentDiscordMessages(params: {
	account: ChatAccountConfig;
	threadId: string;
	limit?: number;
	fetchImpl?: typeof fetch;
}): Promise<DiscordMessageSummary[]> {
	if (params.account.service !== "discord" || !params.account.botToken) return [];
	const limit = Math.max(1, Math.min(params.limit ?? 10, 100));
	const fetcher = params.fetchImpl ?? fetch;
	const response = await fetcher(`https://discord.com/api/v10/channels/${params.threadId}/messages?limit=${limit}`, {
		headers: { Authorization: `Bot ${params.account.botToken}` },
	});
	if (response.status === 403 || response.status === 404) return [];
	const data = (await response.json().catch(() => [])) as DiscordApiMessage[] | { message?: string };
	if (!response.ok || !Array.isArray(data)) {
		const message = !Array.isArray(data) ? data.message : undefined;
		throw new Error(message || `Discord messages fetch failed with HTTP ${response.status}`);
	}
	return data
		.filter((message): message is Required<Pick<DiscordApiMessage, "id" | "timestamp">> & DiscordApiMessage => !!message.id && !!message.timestamp)
		.map((message) => ({
			id: message.id,
			timestamp: message.timestamp,
			authorId: message.author?.id,
			authorBot: message.author?.bot,
		}));
}

async function readWorkerStatus(conversationId: string): Promise<ThreadWorkerStatus | undefined> {
	const path = join(CHAT_HOME, "worker-status", `${tmuxSafeName(conversationId)}.json`);
	try {
		return JSON.parse(await readFile(path, "utf8")) as ThreadWorkerStatus;
	} catch {
		return undefined;
	}
}

async function readLastConversationActivity(conversation: ResolvedConversation): Promise<string | undefined> {
	try {
		const text = await readFile(join(conversation.conversationDir, "channel.jsonl"), "utf8");
		let last: string | undefined;
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as { timestamp?: unknown; type?: unknown };
				if ((parsed.type === "inbound" || parsed.type === "outbound" || parsed.type === "job_completed") && typeof parsed.timestamp === "string") last = parsed.timestamp;
			} catch {
				// Ignore malformed historical records.
			}
		}
		return last;
	} catch {
		return undefined;
	}
}

async function maybeSuspendIdleThread(params: {
	entry: ThreadCatalogEntry;
	conversation: ResolvedConversation;
	idleSuspendMs: number;
	suspendNotice: boolean;
	nowMs: number;
	latestDiscordUserAt?: string;
}): Promise<void> {
	if (params.idleSuspendMs <= 0) return;
	const status = await readWorkerStatus(params.entry.threadConversationId);
	if (!status) return;
	if (status.queueLength || status.hasActiveJob || status.chatTurnInFlight) return;
	const lastActivity = await readLastConversationActivity(params.conversation);
	if (!lastActivity) return;
	const lastMs = Date.parse(lastActivity);
	const latestDiscordUserMs = params.latestDiscordUserAt ? Date.parse(params.latestDiscordUserAt) : undefined;
	const effectiveLastMs = Math.max(
		Number.isFinite(lastMs) ? lastMs : 0,
		latestDiscordUserMs !== undefined && Number.isFinite(latestDiscordUserMs) ? latestDiscordUserMs : 0,
	);
	if (!effectiveLastMs || params.nowMs - effectiveLastMs < params.idleSuspendMs) return;
	const stoppedAt = new Date(params.nowMs).toISOString();
	if (!killWorker(params.entry.threadConversationId, undefined, { now: new Date(params.nowMs) })) return;

	params.entry.stoppedAt = stoppedAt;
	params.entry.lastSessionFile = status.sessionFile ?? params.entry.lastSessionFile;
	const catalog = await readCatalog();
	upsertEntry(catalog, params.entry);
	await writeCatalog(catalog);
	if (params.suspendNotice && params.conversation.account.service === "discord") {
		await sendDiscordChannelEmbed({
			account: params.conversation.account,
			channelId: params.entry.threadId,
			title: "Thread lifecycle",
			description: `Suspending idle pi-chat thread **${params.entry.name}**. It will wake on the next message.`,
		});
	}
}

async function wakeThread(params: {
	entry: ThreadCatalogEntry;
	conversation: ResolvedConversation;
	ctx: ExtensionContext;
	state: SupervisorState;
}): Promise<void> {
	const key = params.entry.threadConversationId;
	if (params.state.waking.has(key)) return;
	params.state.waking.add(key);
	try {
		await sendDiscordChannelEmbed({
			account: params.conversation.account,
			channelId: params.entry.threadId,
			title: "Thread lifecycle",
			description: `Waking pi-chat thread **${params.entry.name}**.`,
		});
		const sessionFile = params.entry.lastSessionFile ?? (await findMostRecentWorkerSession(params.entry.threadConversationId));
		if (!sessionFile) throw new Error(`No saved session file for ${params.entry.name}.`);
		const start = startWorker({ conversationId: params.entry.threadConversationId, sessionFile, cwd: params.ctx.cwd });
		params.entry.stoppedAt = null;
		params.entry.lastSessionFile = sessionFile;
		const catalog = await readCatalog();
		upsertEntry(catalog, params.entry);
		await writeCatalog(catalog);
		await sendDiscordChannelEmbed({
			account: params.conversation.account,
			channelId: params.entry.threadId,
			title: "Thread lifecycle",
			description: `pi-chat thread **${params.entry.name}** has restarted (${start.tmuxName}). Please resend your request now.`,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await sendDiscordChannelEmbed({
			account: params.conversation.account,
			channelId: params.entry.threadId,
			title: "Thread lifecycle",
			description: `Failed to wake pi-chat thread **${params.entry.name}**: ${message}`,
		});
	} finally {
		params.state.waking.delete(key);
	}
}

export async function tickThreadSupervisor(ctx: ExtensionContext, state: SupervisorState, options: Required<SupervisorOptions>): Promise<void> {
	const entries = ctx.sessionManager.getEntries();
	if (getCurrentThreadState(entries)) return;
	const parentConversationId = getCurrentPiChatConversationId(entries);
	if (!parentConversationId) return;

	const config = await loadChatConfig();
	const parent = resolveConversation(config, parentConversationId);
	if (!parent || parent.service !== "discord" || parent.channel.managedBy === "pi-ez-chat-threads") return;
	const catalog = reconcileCatalogWorkerState(await readCatalog());
	const managed = listForParent(catalog, parent.conversationId);
	for (const entry of managed) {
		const conversation = resolveConversation(config, entry.threadConversationId);
		if (!conversation || conversation.service !== "discord") continue;
		let latest: DiscordMessageSummary | undefined;
		try {
			latest = latestUserMessage(
				await fetchRecentDiscordMessages({ account: conversation.account, threadId: entry.threadId, fetchImpl: options.fetchImpl }),
				conversation.account.botUserId,
			);
		} catch {
			continue;
		}
		const alive = isWorkerAlive(entry.threadConversationId);
		const lastSeenId = state.seenMessageIds.get(entry.threadConversationId);
		if (shouldWakeForMessage({ latest, lastSeenId, stoppedAt: entry.stoppedAt, workerAlive: alive })) {
			if (latest) state.seenMessageIds.set(entry.threadConversationId, latest.id);
			await wakeThread({ entry, conversation, ctx, state });
			continue;
		}
		if (latest && (!lastSeenId || compareDiscordSnowflakes(latest.id, lastSeenId) > 0)) {
			state.seenMessageIds.set(entry.threadConversationId, latest.id);
		}
		if (alive) {
			await maybeSuspendIdleThread({
				entry,
				conversation,
				idleSuspendMs: options.idleSuspendMs,
				suspendNotice: options.suspendNotice,
				nowMs: Date.now(),
				latestDiscordUserAt: latest?.timestamp,
			});
		}
	}
}

export function startThreadSupervisor(ctx: ExtensionContext, options: SupervisorOptions = {}): () => void {
	if (!boolFromEnv("PI_EZ_CHAT_THREADS_SUPERVISOR", true)) return () => undefined;
	const resolved: Required<SupervisorOptions> = {
		fetchImpl: options.fetchImpl ?? fetch,
		intervalMs: options.intervalMs ?? numberFromEnv("PI_EZ_CHAT_THREADS_SUPERVISOR_INTERVAL_MS", 15000),
		idleSuspendMs: options.idleSuspendMs ?? numberFromEnv("PI_EZ_CHAT_THREADS_IDLE_SUSPEND_MS", 60 * 60 * 1000),
		suspendNotice: options.suspendNotice ?? boolFromEnv("PI_EZ_CHAT_THREADS_SUSPEND_NOTICE", false),
	};
	if (resolved.intervalMs <= 0) return () => undefined;
	const state: SupervisorState = { seenMessageIds: new Map(), waking: new Set() };
	let running = false;
	const run = () => {
		if (running) return;
		running = true;
		void tickThreadSupervisor(ctx, state, resolved).finally(() => {
			running = false;
		});
	};
	const timer = setInterval(run, resolved.intervalMs);
	timer.unref?.();
	run();
	return () => clearInterval(timer);
}
