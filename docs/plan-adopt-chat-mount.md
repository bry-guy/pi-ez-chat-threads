# Plan: adopt pi-ez-chat-mount, drop workspace copy-seeding

Status: planning. No code changes yet.

## Goal

Make `pi-ez-chat-threads` align with the new `pi-ez-chat-mount` model:

- Threads are durable conversations with their own pi-chat `/workspace` and forked pi session history.
- The user's host repo lives at a sibling host bind (e.g. `/<repo>-<session_name>`) configured by `pi-ez-chat-mount`, **not** inside `/workspace`.
- Creating a thread inherits the parent channel's mount config, so the thread VM sees the same host repo at the same path. After creation, parent and thread mount sets are independent.
- Forking a fork is disallowed.

The previous `seedThreadWorkspace` behavior of `cp -a parent.workspace/. thread.workspace/` becomes obsolete and is removed.

## Background

Today `pi-ez-chat-threads`:

1. Creates a Discord thread.
2. Adds the thread as a pi-chat conversation in `~/.pi/agent/chat/config.json`.
3. Copies the parent channel's `/workspace` contents into the new thread's `/workspace` if the latter is empty (`src/session.ts: seedThreadWorkspace`).
4. Forks the current pi session JSONL into the thread's tmux-sessions dir.
5. Starts a detached tmux pi worker for the thread.

With `pi-ez-chat-mount` in the picture, step 3 is the wrong shape:

- The parent channel's `/workspace` is pi-chat scratch (memory, skills, incoming, agent-written files), not the user's repo.
- The user's repo is at a sibling mount like `/infra-infra-dev`, configured by `pi-ez-chat-mount`.
- Copying `/workspace` only copies scratch state and produces drift.

The correct behavior is to inherit the parent's mount config in `pi-ez-chat-mount`'s storage (`~/.pi/agent/chat-mount/mounts.json`) and leave the thread's `/workspace` to pi-chat.

## Target behavior

After this change, `/chat-thread` does the following, in order:

1. Refuse if the current conversation is already a managed thread (`managedBy === "pi-ez-chat-threads"`). No forking forks.
2. Create the Discord thread and add the thread conversation to `~/.pi/agent/chat/config.json` (unchanged).
3. **Inherit mounts**: read `~/.pi/agent/chat-mount/mounts.json` for the parent conversation, write the same entries under the new thread conversation id. Idempotent. Report which mounts were inherited.
4. Fork the chosen source pi session JSONL into the thread's tmux-sessions dir (unchanged).
5. Start the tmux worker unless `--no-spawn` (unchanged).
6. Post the Discord intro message (unchanged).

What is removed:

- `seedThreadWorkspace` and its `cp -a` call.
- The "workspace files: N" line in the success output is replaced with "inherited mounts: …".
- Documentation that says "copies the current channel workspace into the thread workspace."

What stays:

- pi-chat owns the thread's `/workspace` and `/shared`. We never touch them.
- pi-chat's per-channel `memory.md`, `skills/`, `incoming/`, `.secrets/` are pi-chat's concern.
- Session fork, tmux worker, Discord intro: unchanged.

## Cross-package contract with pi-ez-chat-mount

`pi-ez-chat-mount` owns `~/.pi/agent/chat-mount/mounts.json`. Schema (also documented in `pi-ez-chat-mount/docs/`):

```json
{
  "<accountId>/<channelKey>": {
    "/<guestPath>": {
      "hostPath": "/absolute/host/path",
      "mode": "rw" | "ro"
    }
  }
}
```

Read/write rules `pi-ez-chat-threads` will follow:

- Read parent's entry, copy as-is to a new entry keyed by the thread's `conversationId`.
- Preserve `mode` (no implicit downgrade to `ro`).
- Do not validate `hostPath` existence here; `pi-ez-chat-mount`'s VM wrapper handles missing-path warnings at VM start. Threads simply inherit configuration.
- Idempotent: re-running `/chat-thread` for an existing thread re-syncs mounts from the current parent state. This matches "inherit at creation time" if used once; if rerun, it deliberately re-pulls current parent mounts. We can refine later if that surprises users.

Decision to revisit later: whether re-inheritance on existing-thread reuse is desirable. Initial choice is yes, because it's the least surprising behavior when users add a mount to the parent and want it reflected in their existing thread. Document this clearly in the README.

## Implementation steps

### 1. Add a mount-inheritance helper

New file `src/mounts.ts`:

- `readMountsConfig(): Promise<MountsFile>` — reads `~/.pi/agent/chat-mount/mounts.json`. Returns `{}` if missing.
- `writeMountsConfig(file: MountsFile): Promise<void>` — atomic write.
- `inheritMounts(parentConversationId, threadConversationId): Promise<{ inherited: string[]; skipped: string[] }>` — copies parent entries into thread entries, returns mount names for reporting.
- Types kept narrowly typed to avoid pulling in `pi-ez-chat-mount` as a dep.

### 2. Wire inheritance into the `/chat-thread` flow

Edit `index.ts`:

- After `await saveChatConfig(config);` and after `addThreadConversation(...)`, call `inheritMounts(parentConversationId, thread.conversationId)`.
- Capture the result; surface in the success message:

  ```text
  Created persistent pi thread: <name>
    parent: <parentConversationId>
    conversation: <threadConversationId>
    thread id: <id>
    inherited mounts: <comma-separated guest paths, or "none">
    source session: <description>
  ```

### 3. Remove `seedThreadWorkspace`

- Delete `seedThreadWorkspace` from `src/session.ts`.
- Remove its import from `index.ts`.
- Remove `await mkdir(parent.workspaceDir, { recursive: true });` and the `cp -a` invocation.
- Update tests in `test.ts` to remove the workspace-copy assertions.

### 4. Refuse forking from a managed thread

- Where the parent conversation is resolved, after we have `parent: ResolvedConversation`, check `parent.channel.managedBy === "pi-ez-chat-threads"`. If so, throw with a clear message:

  ```text
  /chat-thread cannot fork from inside an existing managed thread.
  Run /chat-thread from the parent channel instead.
  ```

- Also guard against the current connected conversation being a managed thread, when no explicit `--parent` is given.

### 5. Update success/failure messages

- Drop "workspace files: …".
- Add "inherited mounts: …".
- When `pi-ez-chat-mount`'s storage is absent or empty, say "inherited mounts: none (run /chat-mount in the parent channel if you want the host repo available)."

### 6. README and CHANGELOG

- README:
  - remove the "copies the current channel workspace into the thread workspace" claim,
  - add a section "Mounts" explaining inheritance and pointing at `pi-ez-chat-mount`,
  - add a "Related packages" section linking `pi-chat`, `pi-ez-chat-mount`, `pi-ez-secret-broker`,
  - note that `pi-ez-chat-handoff` has been deleted and is not the path for "use my local repo from chat",
  - note the rule that forking from a managed thread is disallowed,
  - clarify that the thread's own `/workspace` remains pi-chat-managed scratch.
- CHANGELOG:
  - "BREAKING: no longer copies parent channel `/workspace` into thread `/workspace`. Mounts configured by `pi-ez-chat-mount` are inherited instead. Use `pi-ez-chat-mount` if you want your host repo available in the thread VM."

### 7. Version bump

- Minor bump (e.g. `0.3.0`) because behavior changes.
- No package.json hard dependency on `pi-ez-chat-mount`. Add a "Recommended companions" line in README; keep `peerDependencies` only on `@earendil-works/pi-coding-agent` as today.

### 8. Tests

Update `test.ts`:

- Remove assertions about workspace seeding (`"workspace seeded"`, README presence in copied workspace, `.git` presence in copied workspace).
- Add a fake `~/.pi/agent/chat-mount/mounts.json` and assert:
  - inheritance writes the same entries under the new thread conversation id,
  - inheritance is idempotent,
  - empty/missing source file results in `inherited: []`,
  - re-running inheritance for an existing thread mirrors the current parent state.
- Add a test that forking from a managed-thread parent is rejected.

## Validation walkthrough (target end state)

1. From `~/dev/infra` in a named pi session `infra-dev`, `/chat-connect discord-bry-guy/onlyclankers`.
2. `/chat-mount` — `pi-ez-chat-mount` adds `/infra-infra-dev` → `~/dev/infra` to the parent's mounts.
3. `/chat-thread Fix login tests`:
   - creates Discord thread,
   - registers thread conversation,
   - inherits `/infra-infra-dev` into the thread's mount config,
   - forks current pi session, starts tmux worker,
   - reports `inherited mounts: /infra-infra-dev`.
4. In Discord thread, the worker's VM has `/workspace` (empty pi-chat scratch), `/shared`, and `/infra-infra-dev` bound to `~/dev/infra`.
5. From the parent channel, `/chat-disconnect` and reconnect from `~/dev/bar` after `/chat-mount`. Parent now has `/bar-bar-dev`. The thread still has `/infra-infra-dev`.
6. Inside the thread VM, commit and push `foo.md` in `/infra-infra-dev`. On host, `cd ~/dev/infra && git pull` to see the change.
7. `/chat-thread` from inside the thread fails with the "cannot fork from a managed thread" error.

## Risk and follow-ups

- Cross-package coupling on a JSON file. Acceptable for now; both packages document the schema. Long-term, `pi-ez-chat-mount` is the source of truth; consider extracting a tiny shared helper if duplication grows.
- Inheritance-on-reuse semantics may surprise some users. Documented; revisit if real users complain.
- Read-only mounts pass through unchanged; enforcement remains best-effort per `pi-ez-chat-mount` known issues.
- If `pi-ez-chat-mount` is not installed, `/chat-thread` still works; "inherited mounts: none" is reported, threads are usable without host repo access.
