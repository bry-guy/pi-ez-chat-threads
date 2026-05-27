import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MOUNTS_CONFIG_PATH = join(homedir(), ".pi", "agent", "chat-mount", "mounts.json");

export interface MountEntry {
	hostPath: string;
	mode: "rw" | "ro";
	[key: string]: unknown;
}

export type ConversationMounts = Record<string, MountEntry>;
export type MountsFile = Record<string, ConversationMounts>;

function isMountEntry(value: unknown): value is MountEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<MountEntry>;
	return typeof entry.hostPath === "string" && (entry.mode === "rw" || entry.mode === "ro");
}

function validConversationMounts(value: unknown): { mounts: ConversationMounts; skipped: string[] } {
	const mounts: ConversationMounts = {};
	const skipped: string[] = [];
	if (!value || typeof value !== "object" || Array.isArray(value)) return { mounts, skipped };
	for (const [guestPath, entry] of Object.entries(value as Record<string, unknown>)) {
		if (isMountEntry(entry)) mounts[guestPath] = { ...entry };
		else skipped.push(guestPath);
	}
	return { mounts, skipped };
}

export async function readMountsConfig(path = MOUNTS_CONFIG_PATH): Promise<MountsFile> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as MountsFile;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
}

export async function writeMountsConfig(file: MountsFile, path = MOUNTS_CONFIG_PATH): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
	await rename(tmp, path);
}

export async function inheritMounts(
	parentConversationId: string,
	threadConversationId: string,
	path = MOUNTS_CONFIG_PATH,
): Promise<{ inherited: string[]; skipped: string[] }> {
	const file = await readMountsConfig(path);
	const { mounts: parentMounts, skipped } = validConversationMounts(file[parentConversationId]);
	const inherited = Object.keys(parentMounts).sort();

	if (inherited.length === 0) {
		if (file[threadConversationId]) {
			delete file[threadConversationId];
			await writeMountsConfig(file, path);
		}
		return { inherited, skipped };
	}

	file[threadConversationId] = Object.fromEntries(inherited.map((guestPath) => [guestPath, parentMounts[guestPath]]));
	await writeMountsConfig(file, path);
	return { inherited, skipped };
}
