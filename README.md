# pi-ez-chat-threads

`pi-ez-chat-threads` makes a Discord thread a first-class, named, persistent pi session that branches off a main pi-chat channel.

The idea is "main channel as switchboard": you mount projects (`pi-ez-chat-mount`), wire git (`pi-ez-chat-git`), and talk to pi in the main channel. When you want a piece of work to live on its own and survive future switchboard changes, you make a thread for it.

## Mental model

- Each Discord channel is one pi-chat conversation. The connected (`/chat-connect`) channel is what `/chat-mount`, `/chat-git`, etc. configure.
- A thread is another pi-chat conversation, registered under a parent channel. It inherits the parent's mount set at the moment it is created, and forks the parent's pi session history. After that it lives independently.
- pi-chat owns sessions and VMs. This extension only adds lifecycle metadata, mount inheritance, and worker management on top of what pi-chat already does.

## Install

```bash
pi install git:github.com/earendil-works/pi-chat
pi install /absolute/path/to/pi-ez-chat-threads
```

If pi is already running, run `/reload` after installing.

Recommended companions: `pi-ez-chat-mount`, `pi-ez-chat-git`, `pi-ez-secret-broker`.

## Discord setup

This package builds on `pi-chat`; configure Discord there first via `/chat-config` and `/chat-connect <account/channel>`. The Discord bot needs permission to create public threads and post messages.

## Commands

- `/chat-thread <name>` — Create or attach a thread named `<name>` in the connected channel. If it already exists and its worker is dead, the worker is restarted on the existing session file. Names are matched case-insensitively after normalization.
- `/chat-thread end` — End the current thread (run from inside the thread). Kills the worker, marks the thread `ended` in the local catalog, keeps the session file and Discord thread.
- `/chat-thread end <name>` — End a named thread from the parent channel.
- `/chat-thread list` — List managed threads for the connected channel and show worker status.
- `/chat-thread <name> --reactivate` — Reuse the name of an ended thread.
- `--parent=<account/channel>` — Specify a parent explicitly when no pi-chat context is connected.

Names are required. There is no automatic naming from the current pi session, because Discord users have no visibility into pi session names; explicit names are how you and the agent agree on identity.

## Use from Discord

When this package is loaded in the pi-chat worker, Discord users can send the same commands:

```text
@bot /chat-thread Fix login tests
@bot /chat-thread list
@bot /chat-thread end
```

Mentions before or after the command work, and transcript-shaped forwarded lines like `- [time] [uid:...] user: <@bot> /chat-thread ...` are also recognized. Remote `/chat-thread` is always non-interactive — no picker prompts are issued from worker contexts.

## What "create" does

1. Resolves the parent channel from the connected pi-chat conversation (or `--parent=...`).
2. Refuses to create from inside an existing managed thread (run from the parent channel).
3. Creates a Discord thread named exactly what you passed.
4. Registers the new thread as a pi-chat conversation in `~/.pi/agent/chat/config.json` with `managedBy: "pi-ez-chat-threads"`, `parentChannelId`, `parentConversationId`.
5. Copies the parent's `pi-ez-chat-mount` mount entries to the new conversation in `~/.pi/agent/chat-mount/mounts.json`. The thread mounts are frozen at this point; subsequent `/chat-mount` calls in the parent do not propagate to existing threads.
6. Forks the current pi session into the thread's worker session directory and stamps it with `pi-chat-state` and `pi-ez-chat-thread` custom entries.
7. Spawns the worker tmux for the new conversation id.
8. Records the thread in `~/.pi/agent/chat-threads/threads.json` as our lifecycle catalog.

## What "attach" does

When `/chat-thread <name>` matches an existing thread under the parent:

- If the catalog says it's `ended`, you must pass `--reactivate`.
- If the worker tmux is alive, it is reported as already running. No fork, no session change.
- If the worker tmux is dead, the worker is restarted against the last recorded session file. The Discord thread, channel registration, and mounts are not touched.

## What "end" does

- Kills the thread's worker tmux if running.
- Sets `endedAt` in the catalog.
- Leaves the Discord thread, the pi-chat conversation entry, and the session file in place. v1 intentionally does not archive the Discord thread.
- Reactivate later with `/chat-thread <name> --reactivate` from the parent channel.

## Why no `/chat-reload`

pi-chat parses `/new` before extension input hooks fire, so no extension can intercept it or restart the running chat sandbox from inside the VM. The supported reload action is `@bot /new` in the channel. `pi-ez-chat-mount` no longer registers a `/chat-reload` stub.

## Storage

```text
~/.pi/agent/chat/                 # pi-chat conversations, sessions, tmux workers (owned by pi-chat)
~/.pi/agent/chat-mount/mounts.json # parent and thread mount entries (owned by pi-ez-chat-mount)
~/.pi/agent/chat-threads/threads.json # lifecycle catalog for managed threads (owned by this package)
```

## Development

```bash
npm install
npm run validate
```
