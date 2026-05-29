# Changelog

All notable changes to this project will be documented in this file.

## [0.6.0] - 2026-05-29

### Added
- `/chat-thread kill [name]` destructively removes a managed thread: closes the Discord thread, kills the tmux worker, removes the lifecycle catalog entry, removes the pi-chat managed conversation entry, and removes inherited mount config for the thread. Session files are left on disk.
- `/chat-thread rename <target> <name>` renames a managed thread in Discord, the lifecycle catalog, and pi-chat conversation config.

### Fixed
- Thread creation now validates a usable persisted source session before creating the Discord thread, and rolls back local config / closes the Discord thread if worker setup fails after creation.
- Remote transcript matching now prefers the latest matching command in a multi-line Discord transcript, avoiding stale `/chat-thread restart` replay loops.

## [0.5.0] - 2026-05-29

### Breaking
- Replaced `end` / `--reactivate` with `start` / `stop` / `restart`. The verbs are uniform across pi sessions and Discord; the same syntax (`/chat-thread {start|stop|restart|list} [name]`) works in both places, with a bare `/chat-thread <name>` shorthand for `start <name>`.
- Catalog field `endedAt` renamed to `stoppedAt`. Existing 0.4.x catalog files are migrated automatically on read.
- `start <name>` on a stopped thread now restarts it directly; no opt-in flag.

### Added
- `/chat-thread restart [name]` force-restarts a thread (kills tmux, respawns against the existing session file).
- Lifecycle notices (`Starting`/`Stopping`/`Restarting pi-chat thread <name>.`) posted directly to the Discord thread by the bot so the user sees the action take effect even when the worker is about to die (self-stop / self-restart).
- Self-stop and self-restart from inside a thread return `action: "handled"` so the LLM does not preface an undeliverable reply.

### Removed
- `/chat-thread end` and `--reactivate` no longer exist.

## [0.4.2] - 2026-05-29

### Fixed
- New threads no longer wedge on pi's interactive `cwd from session file does not exist` prompt at worker startup. The forked session now records the parent worker's effective cwd (matching pi-chat's own `spawnConversationTmux`); pi-chat switches effective cwd into the Gondolin VM workspace when the sandbox starts.
- `forkSessionForThread` pre-creates the thread's channel workspace dir as a belt-and-suspenders measure.

### Docs
- Added recovery instructions for threads created by 0.4.0/0.4.1 whose workers are stuck on the cwd prompt.

## [0.4.1] - 2026-05-29

### Fixed
- `/chat-thread <name>` from the parent channel no longer falsely reports "Already inside a managed thread." The previous version stamped the parent worker session with a `pi-ez-chat-thread` custom entry before forking, leaking thread state into the parent. The stamp is removed; the fork itself still carries the thread state, as before.
- `getCurrentThreadState` now requires the session's current pi-chat conversation id to equal the thread's own conversation id, so any stale entries left over from 0.4.0 are ignored.

### Docs
- Added `docs/known-issues.md` documenting the upstream pi-chat `/new` reset bug (`sendUserMessage` bypassing `chat-new` command dispatch in `pi-coding-agent`).

## [0.4.0] - 2026-05-29

### Breaking
- `/chat-thread` requires an explicit `<name>`. Auto-naming from session/session-id is removed.
- `/chat-thread` no longer accepts `--new`, `--restart`, or `--no-spawn`. Restart of a dead worker is implicit when attaching by name.
- Remote `/chat-thread` is always non-interactive; no picker prompts can be issued from worker contexts.

### Added
- `/chat-thread <name>` create-or-attach by name under the connected parent channel. Restarts a dead worker against the existing session file when attaching.
- `/chat-thread end` (from inside a thread) and `/chat-thread end <name>` (from the parent) kill the worker and mark the thread `ended` while preserving the session file, the Discord thread, and the pi-chat conversation entry.
- `/chat-thread list` shows managed threads for the connected channel with worker status.
- `/chat-thread <name> --reactivate` re-activates an ended thread.
- Lifecycle catalog at `~/.pi/agent/chat-threads/threads.json` tracks managed threads, last session file, and ended-at timestamps.

### Changed
- Worker spawn logic moved out of session handling into `src/worker.ts` so attach can restart without re-forking.

## [0.3.0] - 2026-05-25

### Breaking
- No longer copies parent channel `/workspace` into thread `/workspace`. Mounts configured by `pi-ez-chat-mount` are inherited instead. Use `pi-ez-chat-mount` if you want your host repo available in the thread VM.

### Added
- Inherit parent `pi-ez-chat-mount` entries from `~/.pi/agent/chat-mount/mounts.json` when creating a managed thread.
- Reject `/chat-thread` when run from inside an existing managed thread.

## [0.2.1] - 2026-05-23

### Fixed
- Remote `/chat-thread` from Discord now defaults to forking the parent channel worker session instead of the command-handling thread session.
- Thread names now prefer the chosen source session name when available.

### Added
- `/chat-ez-thread` remote alias for avoiding pi-chat's built-in unbound-thread response path.

## [0.2.0] - 2026-05-22

### Added
- Interactive source-session picker for `/chat-thread`: current session, a different saved session, or the parent channel worker session.
- Remote `/chat-thread` support via pi's input hook when the package is loaded in a pi-chat worker.

### Changed
- Treat the Discord parent channel and the source pi session as separate choices. The current pi session remains the default source.

## [0.1.1] - 2026-05-22

### Added
- Allow `/chat-thread` from any persisted pi session by passing `--parent=<account/channel>`.
- Add interactive Discord parent channel selection when no pi-chat context is connected.

### Changed
- Clarify that the current pi session is always the session being forked; pi-chat context only selects the Discord parent channel.

## [0.1.0] - 2026-05-22

### Added
- Initial `pi-ez-chat-threads` package.
- `/chat-thread` command for creating persistent Discord thread-backed pi-chat sessions.
- Session-scoped thread reuse so repeated calls return the same durable thread by default.
- Config persistence, workspace seeding, session forking, and single-thread tmux worker spawn.
- Smoke tests for config mutation, thread reuse, workspace seeding, and worker command generation.
