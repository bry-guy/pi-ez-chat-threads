import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const THREADS_CATALOG_PATH = join(homedir(), ".pi", "agent", "chat-threads", "threads.json");

export type ThreadStatus = "active" | "ended";

export interface ThreadCatalogEntry {
	parentConversationId: string;
	threadConversationId: string;
	threadId: string;
	name: string;
	normalizedName: string;
	createdAt: string;
	endedAt: string | null;
	ownerSessionId: string;
	lastSessionFile?: string;
}

export interface ThreadCatalog {
	version: 1;
	threads: Record<string, ThreadCatalogEntry>;
}

export function normalizeThreadName(name: string): string {
	const trimmed = name.trim().toLowerCase();
	const replaced = trimmed.replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/g, "");
	return replaced.slice(0, 64);
}

function emptyCatalog(): ThreadCatalog {
	return { version: 1, threads: {} };
}

export async function readCatalog(path = THREADS_CATALOG_PATH): Promise<ThreadCatalog> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ThreadCatalog>;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyCatalog();
		return { version: 1, threads: (parsed.threads as Record<string, ThreadCatalogEntry>) ?? {} };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyCatalog();
		throw err;
	}
}

export async function writeCatalog(catalog: ThreadCatalog, path = THREADS_CATALOG_PATH): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(catalog, null, "\t")}\n`, "utf8");
	await rename(tmp, path);
}

export function findByName(catalog: ThreadCatalog, parentConversationId: string, normalizedName: string): ThreadCatalogEntry | undefined {
	for (const entry of Object.values(catalog.threads)) {
		if (entry.parentConversationId === parentConversationId && entry.normalizedName === normalizedName) return entry;
	}
	return undefined;
}

export function findByThreadConversationId(catalog: ThreadCatalog, threadConversationId: string): ThreadCatalogEntry | undefined {
	return catalog.threads[threadConversationId];
}

export function listForParent(catalog: ThreadCatalog, parentConversationId: string): ThreadCatalogEntry[] {
	return Object.values(catalog.threads)
		.filter((e) => e.parentConversationId === parentConversationId)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function upsertEntry(catalog: ThreadCatalog, entry: ThreadCatalogEntry): ThreadCatalog {
	catalog.threads[entry.threadConversationId] = entry;
	return catalog;
}
