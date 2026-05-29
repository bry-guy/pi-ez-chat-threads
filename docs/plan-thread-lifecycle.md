# pi-ez-chat-threads lifecycle plan

Goal: drive pi work from Discord with the main pi-chat channel acting as a switchboard. Threads are persistent, explicit, named side-conversations whose VM and pi session continue independently of the main channel. Threads are extensions of pi-chat's native conversation model, not replacements for it.

## What pi-chat actually gives us

Confirmed by current behavior and `~/.pi/agent/chat/`:

- pi-chat tracks "conversations" as `<accountId>/<channelKey>` in `~/.pi/agent/chat/config.json`.
- Each conversation has its own `~/.pi/agent/chat/accounts/<acct>/channels/<key>/workspace/` and matching tmux worker `pi-chat-worker-<conversationId>` driven by pi-chat itself.
- A Discord thread is just another channel id; the pi-chat config does not natively know it's a thread. Our extension stamps `managedBy: "pi-ez-chat-threads"` and `parentConversationId`/`parentChannelId` on the channel entry as side metadata.
- VM mounts are read at `VM.create` time by the `pi-ez-chat-mount` wrapper, keyed by conversation id from `~/.pi/agent/chat-mount/mounts.json`.
- pi-chat's `/new` runs before extension `input` hooks, so we cannot intercept it from inside the VM. `/chat-reload` is therefore a no-op stub today.

Implication: a "thread session" is mechanically the same as a regular pi-chat conversation. Our job is metadata + lifecycle + parent context inheritance, not reinventing the session.

## Mental model for the user

- **Main channel** = switchboard. One persistent pi-chat conversation per channel. `/chat-mount`, `/chat-unmount`, `/chat-mounts`, `/chat-git`, `/chat-connect` all configure or inspect the active conversation.
- **Threads** = "fork the current main-channel context into a named side-session that lives on its own". Inherits the main channel's mount set and forks the parent session. Continues independently from then on.
- **Reset** = `@bot /new` in a channel; that's pi-chat's native operation. We never try to override it.

So mounts and threads are not coupled at runtime. They are coupled at thread-creation time: the new thread snapshots the parent's mounts and forks the parent's session, then becomes its own conversation.

## Naming: require an explicit name

Today `/chat-thread` falls back to session name → session id, which is confusing from Discord where the user can't see the pi session name.

Change:

- `/chat-thread <name>` requires a non-empty name (after stripping mentions / transcript prefix).
- No `--new` flag. The name itself is the lookup key.
- Names are normalized (lowercase, non-alphanumeric → `-`) for the conversation key but the original name is the Discord thread title.
- `/chat-thread end` is a reserved subcommand (see lifecycle).
- `/chat-thread list` is a reserved subcommand to inspect known threads from a channel.

Reuse rule:

- Existing thread with the same normalized name under the parent? Re-attach: if its tmux worker is alive, no-op + report. If dead, restart it. The Discord thread + session file + mounts are preserved as-is.
- Existing thread with a different name from the current session's binding? Create a new one; the new one becomes the binding stamped on the current pi session.

## Lifecycle

States per managed thread (stored in `pi-ez-chat-threads` config, see below):

- `active` — Discord thread exists, conversation registered, worker is or can be running.
- `ended` — closed by `/chat-thread end`; conversation entry kept for history, channel optionally archived on Discord, worker killed, tmux session removed, session file kept for forensics.

Operations:

| Command | From | Effect |
| --- | --- | --- |
| `/chat-thread <name>` | main channel pi-chat | Create-or-restart by name under the current connected channel. Inherits mounts. Forks current pi session. Sends Discord intro. |
| `/chat-thread <name>` | inside an `active` thread | Error: `/chat-thread end` first, or rerun from parent. |
| `/chat-thread <name>` | inside an `ended` thread | Error: cannot recreate from inside; rerun from parent. |
| `/chat-thread end` | inside an `active` thread | Kill worker tmux, mark `ended`, optionally archive Discord thread, leave conversation entry in config for replay. Send Discord notice. |
| `/chat-thread end <name>` | from parent channel | Same, addressed by name (rare). |
| `/chat-thread list` | anywhere | List known threads for the connected channel (or its parent if inside a thread) with status (`active|ended`, worker up/down). |

Edge cases:

- "Kill worker but Discord thread is still open" — the next `/chat-thread <name>` from the parent re-spawns the worker for that conversation id. We do not re-fork the session file when restarting; we resume the existing one.
- "Restart from inside the dead thread" — explicitly unsupported. The thread VM is dead in that case; the user must send the command in the parent channel.
- "Same name as an ended thread" — we treat the name as taken. Either reactivate the ended thread (`/chat-thread <name> --reactivate`) or pick a new name. Default is error: "thread `name` was ended; pick a new name or pass `--reactivate`".

## Where state lives

We already write metadata into the pi-chat channel object. We will additionally maintain our own catalog of threads at:

```text
~/.pi/agent/chat-threads/threads.json
```

Schema (sketch):

```json
{
  "version": 1,
  "threads": {
    "discord-bry-guy/onlyclankers/pi-ez-chat-test-354842": {
      "parentConversationId": "discord-bry-guy/onlyclankers",
      "threadConversationId": "discord-bry-guy/pi-ez-chat-test-354842",
      "threadId": "1509210183690354842",
      "name": "pi-ez-chat-test",
      "createdAt": "...",
      "endedAt": null,
      "ownerSessionId": "019e67c5-...",
      "lastSessionFile": "/Users/brain/.pi/agent/chat/tmux-sessions/pi-chat-worker-.../<file>.jsonl"
    }
  }
}
```

This is the lookup index for "is there an existing thread with this name under this parent". The pi-chat config entry remains the source of truth for the Discord channel id and parent linkage; the threads catalog adds lifecycle and most-recent session file.

## Mount inheritance: confirm the contract

What the user wants: "the whole VM including mounts is copied over to the thread".

Reality:

- VMs are not "copied". Each conversation is its own VM created by Gondolin at `VM.create` time using config for that conversation id.
- Thread conversations start from the parent channel's pi-chat config, then override only thread identity/metadata fields.
- Thread workers inherit the spawning pi process environment and forward pi runtime flags, replacing only session/session-dir/conversation binding, so mise-provided image config and similar runtime settings follow the thread without depending on specific companion extensions.
- Mounts are configured at the host (`~/.pi/agent/chat-mount/mounts.json`) and applied at VM start.
- We already implement mount inheritance: on thread create we copy the parent's `<conversationId>` mount entries to the new thread's `<conversationId>` in the mounts file. We will continue to do that.
- Open question: should subsequent `/chat-mount` calls in the parent propagate to active children? Default no, because that surprises the thread. Optional: `/chat-mount --propagate` later. v1 keeps thread mounts frozen at fork time.

Session and history:

- Forking the pi session for the thread carries over the conversation history up to the fork moment, which is the closest thing to "the same VM" the user perceives.
- We do not copy files out of `/workspace`. pi-chat owns the thread's `/workspace`; the host repo lives via inherited mounts.

## `/chat-reload`: pick one

User options:

1. **Delete it.** Simpler. Document `@bot /new` as the canonical reload.
2. **Replace it with a host-side reload trigger.** Possible only because the extension also runs in the host pi process. The remote `input` handler can write a sentinel; the host-side extension watches the sentinel and runs `pi --reload` on itself. Risky because pi-chat itself isn't owned by us; we can't safely restart the chat worker without it.

Recommendation: **delete `/chat-reload`**. Keep the reload hint string used by `pi-ez-chat-mount` after configuration changes, but stop registering a useless command. Document that the reload action is `@bot /new` in the channel, which pi-chat already handles natively. This avoids us pretending to extend a flow we don't actually control.

## Command surface after this work

`pi-ez-chat-threads`:

- `/chat-thread <name>` — create-or-attach by name under the connected channel.
- `/chat-thread end [name]` — end the current thread (or named one from parent).
- `/chat-thread list` — show threads for the connected channel.
- Remote `input` hook recognizes all of these via `pi-ez-lib`.
- Always non-interactive when triggered remotely.
- No `--new`, no `--restart`, no `--no-spawn`. Restart is implicit when reattaching with a dead worker.

`pi-ez-chat-mount`:

- Drop `/chat-reload`. Keep `/chat-mount`, `/chat-unmount`, `/chat-mounts`.
- Reload hint message stays, but does not register a stub command.

`pi-ez-chat-git`:

- Unchanged for this work.

## Implementation steps

1. **Library work** (still in `pi-ez-lib`):
   - Add a tiny shared "thread name" normalizer so threads and mounts agree.
   - Optional: helper to detect "is this conversation a managed thread?" from pi-chat config.

2. **Catalog** (`pi-ez-chat-threads`):
   - `src/catalog.ts`: read/write `~/.pi/agent/chat-threads/threads.json`.
   - On every `/chat-thread <name>` create-or-attach, update the catalog.
   - On `end`, mark `endedAt`, do not delete.

3. **Worker control**:
   - New `src/worker.ts`:
     - `isWorkerAlive(conversationId)` (tmux has-session)
     - `startWorker({ conversationId, sessionFile, cwd })`
     - `restartWorker(...)`
     - `killWorker(conversationId)` for `end`
   - Reuse the existing `spawnThreadWorker` logic but pull it out of `session.ts` so it's not entangled with forking.

4. **Refactor `index.ts`** in `pi-ez-chat-threads` into three handlers:
   - `chatThreadCreateOrAttach(name, ctx, { remote })`
   - `chatThreadEnd(targetName | "self", ctx, { remote })`
   - `chatThreadList(ctx, { remote })`
   - Single command registration + single `input` hook that dispatches based on first token.

5. **Refuse interactive prompts entirely** in `/chat-thread`:
   - With explicit naming, we no longer need the source-session picker or the parent-channel picker. From the parent channel, the parent is implied by `chat-connect`. From inside a thread, attach is forbidden. From CLI without pi-chat context, require `--parent=`. No `ui.select` left in remote flows.

6. **`pi-ez-chat-mount`**:
   - Delete `chat-reload` registration; keep the reload hint string used by other commands.
   - Update README.

7. **README updates**:
   - Document switchboard model.
   - Document `/chat-thread <name>` / `end` / `list`.
   - Document mount-inheritance freeze and reload path (`@bot /new`).

8. **Tests**:
   - Catalog round-trip.
   - Name normalization conflict resolution (same name twice under same parent).
   - Worker restart path (mocked tmux).
   - Remote input parsing for `end` and `list` subcommands.

## Out of scope for this pass

- Live propagation of `/chat-mount` changes to existing thread VMs.
- Auto-archiving Discord threads on `end` (we just kill the worker for v1; optional Discord archive in v2).
- Real host-side `/chat-reload` replacement.
- Anything that requires modifying pi-chat itself.

## Open questions for you

1. Do you want `end` to also delete the thread's session file (`tmux-sessions/<thread>.jsonl`)? Default: keep it. You can resume via `/resume` from a fresh pi session if pi-chat is ever pointed at it again.
2. Do you want `end` to call Discord `PATCH /channels/{id}` with `archived: true, locked: true`? Default: no for v1.
3. Do you want `/chat-thread list` to be available remotely (Discord), or only locally? Default: both, since it's read-only.
4. Should `/chat-thread <name> --reactivate` be a thing in v1, or should "reusing an ended name" just error?
