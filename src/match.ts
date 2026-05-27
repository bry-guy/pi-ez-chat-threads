export type CommandMatch = { name: string; args: string };

export function stripLeadingMention(text: string): string {
	let rest = text.trimStart();
	while (true) {
		const next = rest.replace(/^(?:<@!?\d+>|<@&\d+>|@[\w.-]+)\s*/u, "");
		if (next === rest) return rest;
		rest = next.trimStart();
	}
}

export function matchSlashCommand(text: string, aliases: readonly string[]): CommandMatch | undefined {
	const stripped = stripLeadingMention(text);
	for (const alias of aliases) {
		const command = `/${alias}`;
		if (stripped === command) return { name: alias, args: "" };
		if (stripped.startsWith(`${command} `) || stripped.startsWith(`${command}\n`) || stripped.startsWith(`${command}\t`)) {
			return { name: alias, args: stripped.slice(command.length).trim() };
		}
	}
	return undefined;
}
