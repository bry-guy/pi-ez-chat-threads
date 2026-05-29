import type { ChatAccountConfig } from "./chat.js";

export interface CreatedDiscordThread {
	id: string;
	name: string;
}

export async function createDiscordThread(params: {
	account: ChatAccountConfig;
	parentChannelId: string;
	name: string;
	autoArchiveDuration?: 60 | 1440 | 4320 | 10080;
	fetchImpl?: typeof fetch;
}): Promise<CreatedDiscordThread> {
	if (params.account.service !== "discord") throw new Error("/chat-thread only supports Discord conversations");
	if (!params.account.botToken) throw new Error("Discord bot token missing from pi-chat account config");
	const fetcher = params.fetchImpl ?? fetch;
	const response = await fetcher(`https://discord.com/api/v10/channels/${params.parentChannelId}/threads`, {
		method: "POST",
		headers: {
			Authorization: `Bot ${params.account.botToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			name: params.name,
			type: 11,
			auto_archive_duration: params.autoArchiveDuration ?? 10080,
		}),
	});
	const data = (await response.json().catch(() => ({}))) as { id?: string; name?: string; message?: string };
	if (!response.ok || !data.id) {
		throw new Error(data.message || `Discord thread create failed with HTTP ${response.status}`);
	}
	return { id: data.id, name: data.name ?? params.name };
}

/**
 * Post a message into a Discord channel/thread directly via the bot. Used for lifecycle
 * notices that need to land before the worker dies (self-stop) or before the worker exists
 * (start intro). Best-effort; failures are swallowed.
 */
export async function sendDiscordChannelMessage(params: {
	account: ChatAccountConfig;
	channelId: string;
	content: string;
	fetchImpl?: typeof fetch;
}): Promise<void> {
	if (!params.account.botToken) return;
	const fetcher = params.fetchImpl ?? fetch;
	await fetcher(`https://discord.com/api/v10/channels/${params.channelId}/messages`, {
		method: "POST",
		headers: { Authorization: `Bot ${params.account.botToken}`, "content-type": "application/json" },
		body: JSON.stringify({ content: params.content }),
	}).catch(() => undefined);
}

export async function sendDiscordThreadIntro(params: {
	account: ChatAccountConfig;
	threadId: string;
	content: string;
	fetchImpl?: typeof fetch;
}): Promise<void> {
	return sendDiscordChannelMessage({
		account: params.account,
		channelId: params.threadId,
		content: params.content,
		fetchImpl: params.fetchImpl,
	});
}
