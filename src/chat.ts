import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CHAT_HOME = join(homedir(), ".pi", "agent", "chat");
export const CHAT_CONFIG_PATH = join(CHAT_HOME, "config.json");
export const WORKER_TMUX_PREFIX = "pi-chat-worker-";
export const PI_CHAT_STATE_TYPE = "pi-chat-state";
export const THREAD_STATE_TYPE = "pi-ez-chat-thread";

export interface AccessPolicy {
	trigger?: "mention" | "message";
	ignoreBots?: boolean;
	allowedUserIds?: string[];
	allowedRoleIds?: string[];
}

export interface GondolinConfig {
	secrets?: Record<string, { value: string; hosts: string[] }>;
}

export interface ConfiguredChannel {
	id: string;
	name?: string;
	dm?: boolean;
	access?: AccessPolicy;
	gondolin?: GondolinConfig;
	// Extra metadata ignored by pi-chat, used by this package.
	parentChannelId?: string;
	parentConversationId?: string;
	managedBy?: string;
	threadOwnerSessionId?: string;
}

export interface ChatAccountConfig {
	service: "discord" | "telegram";
	name?: string;
	access?: AccessPolicy;
	gondolin?: GondolinConfig;
	channels: Record<string, ConfiguredChannel>;
	botToken?: string;
	applicationId?: string;
	serverId?: string;
	serverName?: string;
	botUserId?: string;
	botUsername?: string;
}

export interface ChatConfig {
	botName?: string;
	gondolin?: GondolinConfig;
	accounts: Record<string, ChatAccountConfig>;
}

export interface ResolvedConversation {
	service: "discord" | "telegram";
	accountId: string;
	account: ChatAccountConfig;
	channelKey: string;
	channel: ConfiguredChannel;
	conversationId: string;
	conversationName: string;
	accountDir: string;
	sharedDir: string;
	conversationDir: string;
	workspaceDir: string;
	channelMemoryPath: string;
}

export async function loadChatConfig(path = CHAT_CONFIG_PATH): Promise<ChatConfig> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as ChatConfig;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { accounts: {} };
		throw err;
	}
}

export async function saveChatConfig(config: ChatConfig, path = CHAT_CONFIG_PATH): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}

export function sanitizePathSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function makeChannelKey(base: string, id: string, existing: Record<string, unknown>): string {
	const normalized = base
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48) || "thread";
	let key = `${normalized}-${id.slice(-6)}`;
	let i = 2;
	while (key in existing) key = `${normalized}-${id.slice(-6)}-${i++}`;
	return key;
}

export function tmuxSafeName(conversationId: string): string {
	const safe = conversationId.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "channel";
	return `${WORKER_TMUX_PREFIX}${safe}`.slice(0, 100);
}

export function resolveConversation(config: ChatConfig, conversationId: string): ResolvedConversation | undefined {
	const slash = conversationId.indexOf("/");
	if (slash === -1) return undefined;
	const accountId = conversationId.slice(0, slash);
	const channelKey = conversationId.slice(slash + 1);
	const account = config.accounts?.[accountId];
	const channel = account?.channels?.[channelKey];
	if (!account || !channel) return undefined;
	const accountDir = join(CHAT_HOME, "accounts", sanitizePathSegment(accountId));
	const conversationDir = join(accountDir, "channels", sanitizePathSegment(channelKey));
	return {
		service: account.service,
		accountId,
		account,
		channelKey,
		channel,
		conversationId,
		conversationName: `${account.name ?? accountId} / ${channel.name ?? channelKey}`,
		accountDir,
		sharedDir: join(accountDir, "shared"),
		conversationDir,
		workspaceDir: join(conversationDir, "workspace"),
		channelMemoryPath: join(conversationDir, "workspace", "memory.md"),
	};
}

export function listDiscordParentConversations(config: ChatConfig): ResolvedConversation[] {
	const out: ResolvedConversation[] = [];
	for (const [accountId, account] of Object.entries(config.accounts ?? {})) {
		if (account.service !== "discord") continue;
		for (const channelKey of Object.keys(account.channels ?? {})) {
			const resolved = resolveConversation(config, `${accountId}/${channelKey}`);
			if (!resolved) continue;
			// Managed thread entries are valid pi-chat conversations, but they should not
			// be offered as parents for another persistent thread by default.
			if (resolved.channel.managedBy === "pi-ez-chat-threads") continue;
			out.push(resolved);
		}
	}
	return out.sort((a, b) => a.conversationId.localeCompare(b.conversationId));
}

export function removeConversation(config: ChatConfig, conversationId: string): boolean {
	const slash = conversationId.indexOf("/");
	if (slash === -1) return false;
	const accountId = conversationId.slice(0, slash);
	const channelKey = conversationId.slice(slash + 1);
	const account = config.accounts?.[accountId];
	if (!account?.channels?.[channelKey]) return false;
	delete account.channels[channelKey];
	return true;
}

export function addThreadConversation(params: {
	config: ChatConfig;
	parent: ResolvedConversation;
	threadId: string;
	threadName: string;
	sessionId: string;
}): ResolvedConversation {
	const account = params.config.accounts[params.parent.accountId];
	if (!account) throw new Error(`Missing account ${params.parent.accountId}`);
	const existing = Object.entries(account.channels).find(([, channel]) => channel.id === params.threadId);
	let channelKey: string;
	if (existing) {
		channelKey = existing[0];
		existing[1].name = params.threadName;
		existing[1].managedBy ??= "pi-ez-chat-threads";
	} else {
		channelKey = makeChannelKey(params.threadName, params.threadId, account.channels);
		account.channels[channelKey] = {
			...params.parent.channel,
			id: params.threadId,
			name: params.threadName,
			parentChannelId: params.parent.channel.id,
			parentConversationId: params.parent.conversationId,
			managedBy: "pi-ez-chat-threads",
			threadOwnerSessionId: params.sessionId,
		};
	}
	const resolved = resolveConversation(params.config, `${params.parent.accountId}/${channelKey}`);
	if (!resolved) throw new Error("Failed to resolve newly-created thread conversation");
	return resolved;
}
