# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0](https://github.com/bry-guy/pi-ez-chat-threads/compare/v0.6.0...v1.0.0) (2026-06-05)


### ⚠ BREAKING CHANGES

* replace end + --reactivate with start/stop/restart.
    - Same syntax in pi session and from Discord (@bot /chat-thread ...).
    - Bare /chat-thread <name> is shorthand for start <name>.
    - start <name> attaches to existing thread; restarts the worker if it
      was stopped or if the tmux session is dead.
    - restart force-restarts the worker (kills tmux, respawns from the
      recorded session file).
    - stop kills the worker and marks the catalog entry stoppedAt.
      The Discord thread, pi-chat conversation entry, and session file
      are all preserved.
    - list unchanged.
* /chat-thread now requires an explicit <name>.
    - Auto-naming from session removed.
    - --new, --restart, --no-spawn flags removed; restart is implicit.
    - Remote /chat-thread is always non-interactive.

### Features

* add chat thread resume command ([75ad09d](https://github.com/bry-guy/pi-ez-chat-threads/commit/75ad09d0105445d950ff9f6b111d1877486d38fa))
* add interactive session source picker ([a2daa8a](https://github.com/bry-guy/pi-ez-chat-threads/commit/a2daa8a3dc721da2c5c11edaebd56e0bbf2a0329))
* adopt chat mount integration and mention commands ([e0d595e](https://github.com/bry-guy/pi-ez-chat-threads/commit/e0d595ef278884e8cc0cf3e35fff14ec7b503e2e))
* allow thread creation from any pi session ([ce81e9a](https://github.com/bry-guy/pi-ez-chat-threads/commit/ce81e9ae258559d2c0b28f6a41e8c1b18a637f23))
* inherit chat mounts for threads ([86244df](https://github.com/bry-guy/pi-ez-chat-threads/commit/86244dfbd87c65c55798e7b3b47ce99fb232e86f))
* initial persistent chat threads package ([02204e9](https://github.com/bry-guy/pi-ez-chat-threads/commit/02204e97a33a6f51e1ebc711558f7633b4dcedb5))
* kill and rename managed threads ([15cea8c](https://github.com/bry-guy/pi-ez-chat-threads/commit/15cea8c904a6f29c032d89ba66fcd600393674d1))
* start/stop/restart/list lifecycle ([35e7f15](https://github.com/bry-guy/pi-ez-chat-threads/commit/35e7f15a52600a314836138dd3150db9159e351d))
* supervise dormant chat threads ([38120eb](https://github.com/bry-guy/pi-ez-chat-threads/commit/38120ebf97378dfba79be0a530a752af8f6833c2))
* thread lifecycle with named create/attach/end/list ([c0cc628](https://github.com/bry-guy/pi-ez-chat-threads/commit/c0cc628d714d65f5f71977a88e6a1c2153495b7b))


### Bug Fixes

* do not record thread workspace as forked session cwd ([fa1bdd8](https://github.com/bry-guy/pi-ez-chat-threads/commit/fa1bdd8ce990c8197fe0a19270bcaaca0955e3d7))
* do not stamp parent session with thread state ([1f8dae0](https://github.com/bry-guy/pi-ez-chat-threads/commit/1f8dae07b97a8392339a41b2c82d8e0c368fab11))
* fence remote slash command responses ([709d422](https://github.com/bry-guy/pi-ez-chat-threads/commit/709d42289b9660ae7cf20e7f18214aa6b3c683ef))
* fork parent worker for remote thread commands ([45a78c0](https://github.com/bry-guy/pi-ez-chat-threads/commit/45a78c0f7f732ba6ad8007146dd9412ee34956a6))
* handle remote chat-thread noninteractively ([dac6d5b](https://github.com/bry-guy/pi-ez-chat-threads/commit/dac6d5bf50083f531ffe957cf5f61891b98c6d19))
* harden thread worker lifecycle state ([a509032](https://github.com/bry-guy/pi-ez-chat-threads/commit/a509032a192f4dd68f047f14317e3850d1f8611b))
* inherit chat-git config for managed threads ([ed6721e](https://github.com/bry-guy/pi-ez-chat-threads/commit/ed6721e305e382b555182a7b90da7ac92a762ce3))
* inherit parent runtime for chat threads ([bc4414b](https://github.com/bry-guy/pi-ez-chat-threads/commit/bc4414bbfec34f5c0ab271a247712f752f939518))
* support mention-prefixed chat thread commands ([72efccf](https://github.com/bry-guy/pi-ez-chat-threads/commit/72efccf56a6d589fd3a49687f9c3dd6eaae92ea5))
* use latest-line-only remote command matcher ([4e89f7e](https://github.com/bry-guy/pi-ez-chat-threads/commit/4e89f7ed6c76c49f5ae1c5ea8064cffa949eacb9))
* use line-by-line transcript command matcher ([2b9d5bd](https://github.com/bry-guy/pi-ez-chat-threads/commit/2b9d5bdd680c027e4677420e8a8d9133d0588d75))

## [0.6.0] - 2026-05-29

### Added
- `/chat-thread kill [name]` destructively removes a managed thread: closes the Discord thread, kills the tmux worker, removes the lifecycle catalog entry, removes the pi-chat managed conversation entry, and removes inherited mount config for the thread. Session files are left on disk.
- `/chat-thread rename <target> <name>` renames a managed thread in Discord, the lifecycle catalog, and pi-chat conversation config.

### Fixed
- Thread creation now validates a usable persisted source session before creating the Discord thread, and rolls back local config / closes the Discord thread if worker setup fails after creation.
- Remote transcript matching now prefers the latest matching command in a multi-line Discord transcript, avoiding stale `/chat-thread restart` replay loops.
- Thread workers now preserve parent channel runtime config fields and forward pi runtime args/environment so custom Gondolin image settings carry into new thread workers.
- Thread creation now inherits parent `pi-ez-chat-git` config so `/gondolin-git` and SSH-agent git auth are available in new thread VMs when enabled in the parent.

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
