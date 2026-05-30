# pi-ez-chat-threads

`pi-ez-chat-threads` makes a Discord thread a first-class, named, persistent pi session that branches off a main pi-chat channel.

The idea is "main channel as switchboard": you mount projects (`pi-ez-chat-mount`), wire git (`pi-ez-chat-git`), and talk to pi in the main channel. When you want a piece of work to live on its own and survive future switchboard changes, you make a thread for it.

## Mental model

- Each Discord channel is one pi-chat conversation. The connected (`/chat-connect`) channel is what `/chat-mount`, `/chat-git`, etc. configure.
- A thread is another pi-chat conversation, registered under a parent channel. It inherits the parent's channel runtime config, mount set, and pi-ez-chat-git config at the moment it is created, and forks the parent's pi session history. After that it lives independently.
- pi-chat owns sessions and VMs. This extension only adds lifecycle metadata, mount inheritance, worker management, and a lightweight parent-channel supervisor on top of what pi-chat already does.
- A stopped tmux worker is only a dormant runner. The Discord thread, pi session file, workspace, mounts, and git config remain durable.

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

All commands work the same from a pi session and from Discord (`@bot /chat-thread ...`). The first word is the verb; a bare name is shorthand for `start <name>`.

- `/chat-thread <name>` — Shorthand for `start <name>`.
- `/chat-thread start <name>` — Start a new thread, or attach to an existing one. If the worker is already running, this just announces and returns. If it was previously stopped, the worker is force-restarted against the existing session file.
- `/chat-thread stop` (inside a thread) — Stop the current thread's worker. Posts a notice to Discord first, then kills the tmux worker.
- `/chat-thread stop <name>` (from the parent channel) — Stop a named thread.
- `/chat-thread restart <name>` — Force-restart a thread by name (from anywhere).
- `/chat-thread restart` (inside a thread) — Force-restart the current thread. The worker exits and is respawned; the response message is posted directly to Discord, not via the agent.
- `/chat-thread kill <name>` — Destructive delete: stop the worker, remove this package's catalog entry, remove the pi-chat conversation entry, remove inherited mount config, and close the Discord thread.
- `/chat-thread kill` (inside a thread) — Kill the current thread. The worker exits and the Discord thread is closed.
- `/chat-thread rename <target> <name>` — Rename a managed thread in the catalog, pi-chat conversation config, and Discord.
- `/chat-thread list` — List managed threads for the connected channel and show worker status.
- `/chat-resume` — Local interactive picker for managed Discord thread sessions. Shows friendly Discord thread names and switches the current desktop Pi into the selected thread session.
- `/chat-resume <name>` — Resume a named managed thread directly. If the thread worker is running, local UI asks whether to show the tmux attach command or stop the worker and take over in the current Pi.
- `--parent=<account/channel>` — Specify a parent channel explicitly when no pi-chat context is connected.

Names are required for `start`. There is no automatic naming from the current pi session; explicit names are how you and the agent agree on identity, especially from Discord where pi session names are invisible.

Lifecycle is `start → stop → (re)start`, with `kill` as the destructive cleanup path. There is no `end` and no `--reactivate`; `start <name>` on a stopped/dormant thread restarts it. The catalog records `stoppedAt` rather than `endedAt`; `stop` preserves the Discord thread and session file, while `kill` removes local thread configuration and closes the Discord thread.

A parent-channel supervisor runs in connected parent pi-chat sessions by default. It watches managed Discord threads, suspends idle thread workers after one hour, and wakes dormant workers when a new user message appears in the thread. Because upstream pi-chat currently does not queue the wake-up message as an agent turn during catch-up, the supervisor posts a clear notice after restart asking the user to resend their request. Configure with:

- `PI_EZ_CHAT_THREADS_SUPERVISOR=0` — disable the supervisor.
- `PI_EZ_CHAT_THREADS_SUPERVISOR_INTERVAL_MS=15000` — polling interval.
- `PI_EZ_CHAT_THREADS_IDLE_SUSPEND_MS=3600000` — idle suspend timeout; set `0` to disable auto-suspend.
- `PI_EZ_CHAT_THREADS_SUSPEND_NOTICE=1` — post a Discord notice when idle workers are suspended.

## Use from Discord

Mentions before or after the command work, and transcript-shaped forwarded lines like `- [time] [uid:...] user: <@bot> /chat-thread ...` are also recognized. Remote `/chat-thread` is always non-interactive — no picker prompts are issued from worker contexts.

Lifecycle notices (`Starting pi-chat thread X.` / `Stopping pi-chat thread X.` / `Restarting pi-chat thread X.` / `Killing pi-chat thread X.`) are posted directly to the thread's Discord channel by the bot. For self-stop, self-restart, and self-kill this is necessary because the worker dies before any agent reply could be delivered. Supervisor wake notices are also posted directly: first `Waking pi-chat thread X.`, then `pi-chat thread X has restarted... Please resend your request now.`

## What `start <name>` does for a new thread

1. Resolves the parent channel from the connected pi-chat conversation (or `--parent=...`).
2. Refuses to create from inside an existing managed thread (run from the parent channel).
3. Creates a Discord thread named exactly what you passed.
4. Registers the new thread as a pi-chat conversation in `~/.pi/agent/chat/config.json` with `managedBy: "pi-ez-chat-threads"`, `parentChannelId`, `parentConversationId`, while preserving the parent's channel-level pi-chat configuration fields.
5. Copies the parent's `pi-ez-chat-mount` mount entries to the new conversation in `~/.pi/agent/chat-mount/mounts.json`. The thread mounts are frozen at this point; subsequent `/chat-mount` calls in the parent do not propagate to existing threads.
6. Copies the parent's `pi-ez-chat-git` entry to the new conversation in `~/.pi/agent/chat-git/conversations.json`, so git identity/SSH-agent wiring applies in the thread VM after startup.
7. Forks the current pi session into the thread's worker session directory and stamps it with `pi-chat-state` and `pi-ez-chat-thread` custom entries.
8. Spawns the worker tmux for the new conversation id using the current process environment and forwarded pi runtime flags, replacing only the session/session-dir/conversation binding.
9. Records the thread in `~/.pi/agent/chat-threads/threads.json` as our lifecycle catalog.

## What `/chat-resume` does

`/chat-resume` is for local desktop Pi sessions. It does not parse raw tmux/session ids; it reads the managed thread catalog and presents Discord thread names. Choosing a dormant thread switches the current Pi to the thread's saved JSONL session file, whose persisted pi-chat state reconnects the session to the Discord thread. Choosing a running thread lets you either view the `tmux attach` command or stop that worker and take over locally.

Remote Discord users should keep using `/chat-thread start <name>` / `/chat-thread restart <name>`; `/chat-resume` is intentionally a local session-switching command.

## What `start <name>` / `restart <name>` does for an existing thread

- If the worker tmux is alive (and verb is `start`), it announces and returns without re-spawning.
- If the worker tmux is dead, or the verb is `restart`, the worker is killed (if alive) and respawned against the last recorded session file. The Discord thread, channel registration, and mounts are not touched.
- `stoppedAt` is cleared on successful (re)start.

## What `stop` does

- Posts `Stopping pi-chat thread <name>.` to the Discord thread.
- Kills the worker tmux.
- Sets `stoppedAt` in the catalog.
- Leaves the Discord thread, the pi-chat conversation entry, and the session file in place.
- A later user message in that Discord thread can be detected by the parent supervisor and will restart the worker.

## What `rename` does

- Renames the Discord thread.
- Updates the lifecycle catalog name and normalized lookup name.
- Updates the pi-chat managed conversation display name.
- Does not rename the conversation id/channel key or any session files.

## What `kill` does

- Posts `Killing pi-chat thread <name>.` to the Discord thread.
- Archives and locks the Discord thread.
- Kills the worker tmux.
- Removes the thread from `~/.pi/agent/chat-threads/threads.json`.
- Removes the managed thread conversation from `~/.pi/agent/chat/config.json`.
- Removes inherited mount config for the thread from `~/.pi/agent/chat-mount/mounts.json`.
- Removes inherited git config for the thread from `~/.pi/agent/chat-git/conversations.json`.
- Leaves historical session files on disk.

## Why no `/chat-reload`

pi-chat parses `/new` before extension input hooks fire, so no extension can intercept it or restart the running chat sandbox from inside the VM. The supported reload action is `@bot /new` in the channel. `pi-ez-chat-mount` no longer registers a `/chat-reload` stub.

## Storage

```text
~/.pi/agent/chat/                 # pi-chat conversations, sessions, tmux workers (owned by pi-chat)
~/.pi/agent/chat-mount/mounts.json # parent and thread mount entries (owned by pi-ez-chat-mount)
~/.pi/agent/chat-git/conversations.json # parent and thread git/SSH config (owned by pi-ez-chat-git)
~/.pi/agent/chat-threads/threads.json # lifecycle catalog for managed threads (owned by this package)
```

## Development

```bash
npm install
npm run validate
```
