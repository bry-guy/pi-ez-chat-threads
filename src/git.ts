import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CHAT_GIT_CONFIG_PATH = join(homedir(), ".pi", "agent", "chat-git", "conversations.json");

export type ChatGitConversationConfig = Record<string, unknown>;
export type ChatGitStore = Record<string, ChatGitConversationConfig>;

export async function readChatGitStore(path = CHAT_GIT_CONFIG_PATH): Promise<ChatGitStore> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ChatGitStore : {};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
}

export async function writeChatGitStore(store: ChatGitStore, path = CHAT_GIT_CONFIG_PATH): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(store, null, "\t")}\n`, "utf8");
	await rename(tmp, path);
}

export async function inheritChatGitConfig(parentConversationId: string, threadConversationId: string, path = CHAT_GIT_CONFIG_PATH): Promise<boolean> {
	const store = await readChatGitStore(path);
	const parent = store[parentConversationId];
	if (!parent) {
		if (store[threadConversationId]) {
			delete store[threadConversationId];
			await writeChatGitStore(store, path);
		}
		return false;
	}
	store[threadConversationId] = JSON.parse(JSON.stringify(parent)) as ChatGitConversationConfig;
	await writeChatGitStore(store, path);
	return true;
}

export async function removeChatGitConfig(conversationId: string, path = CHAT_GIT_CONFIG_PATH): Promise<boolean> {
	const store = await readChatGitStore(path);
	if (!store[conversationId]) return false;
	delete store[conversationId];
	await writeChatGitStore(store, path);
	return true;
}
