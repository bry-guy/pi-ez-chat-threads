# Known issues

The bigger upstream issues this package depends on — `/new` not actually
restarting the worker, no extension API for restarting the sandbox, no
first-class pi-chat threads, no way to queue a wake-up message as an agent
turn — are all rolled up in a single document:

**[pi-ez-lib/wishlist.md](../../pi-ez-lib/wishlist.md)**

Items relevant to this package:

- §1 — `@bot /new` is documented as the reload action everywhere, but the
  upstream catch in §1 is that `/new` silently fails to actually start a
  new pi session: pi-chat posts the friendly "Starting a new pi session"
  reply from the host bridge, then injects `/chat-new` via
  `pi.sendUserMessage(..., { deliverAs: "followUp" })`, and
  `agent-session.prompt(text, { expandPromptTemplates: false })` drops
  slash commands. The receipts (call site, gate, registered command) are
  in the wishlist.
- §6 — supervisor wake-up starts a dormant thread worker but cannot queue
  the wake-up Discord message as an agent turn. The supervisor therefore
  posts a "please resend your request" notice after restart. We
  deliberately do not fake this from the extension side.
- §7 — first-class pi-chat threads (so mount inheritance, lifecycle
  catalog, and session forking move from this package into pi-chat itself).

## Package-local notes

### Threads add lifecycle on top of pi-chat conversations, not on top of pi-chat itself

`pi-ez-chat-threads` does not extend pi-chat's session/VM model. A "thread"
is mechanically just another pi-chat conversation
(`<accountId>/<channelKey>`) registered in `~/.pi/agent/chat/config.json`
with extra metadata (`managedBy: "pi-ez-chat-threads"`,
`parentConversationId`). We layer on:

- a Discord thread creation step,
- mount inheritance at fork time (via
  `~/.pi/agent/chat-mount/mounts.json`),
- a fork of the parent's pi session into the thread's worker session
  directory,
- a lifecycle catalog at `~/.pi/agent/chat-threads/threads.json`.

Mounts do not propagate to existing threads after creation. By design: a
thread's VM should be a stable, named environment, not a moving target.

### Catalog and worker-status drift after a worker dies or a parent is reconnected

Status: fixed after 0.6.0. `killWorker` now stamps worker-status as
`dead`, `startWorker --restart` stamps it as `restarting`, and list /
supervisor paths cross-check tmux liveness before trusting catalog
state. New catalog writes no longer set `ownerSessionId`; old catalogs
are still readable.

Two independent things used to go stale and silently lie about a
thread's state. Both surfaced in a real session and both could make a
working thread look stuck.

**1. `worker-status/<tmux-session>.json` is never invalidated when a
worker dies.** The worker writes this file from inside the live pi
process. If the worker exits without going through `/chat-thread stop`
(for example, a `/chat-compact` crash or any other exception that takes
the process down), nothing rewrites the file. External readers and the
thread itself will see the stale `state: connected`, the dead `pid`, and
the old `updatedAt` until a new worker overwrites it on startup. The
right fix is for `pi-ez-chat-threads` to wipe or stamp this file when it
knows the worker has died (kill paths and on-restart preflight).

**2. Catalog `stoppedAt` drifts in both directions.**

- After `restartExistingThread` starts a new worker, the catalog is only
  updated by the process that ran the restart. If the restart was driven
  by the supervisor in another pi process, that process writes the
  catalog. If the restart was driven from a remote `/chat-thread restart`
  through Discord, the parent worker writes it. Either way, the
  thread worker itself never writes `stoppedAt: null` on its own boot.
  If anything goes wrong on the writer side, the catalog still says
  `stoppedAt: <timestamp>` even though tmux now has a fresh, live worker
  session.
- When a worker dies outside `/chat-thread stop` (the same
  `/chat-compact` shape, segfaults, host reboots), nothing sets
  `stoppedAt` either. The catalog continues to say the thread is
  running.

Net effect: `stoppedAt` is an unreliable single source of truth. Any
feature that gates on it (the supervisor's wake check uses it as one
input; `/chat-thread list` reports it) needs to cross-check tmux liveness
before acting. A simple correctness fix: treat tmux as the source of
truth for "running", and use `stoppedAt` only as an advisory timestamp.

**3. `ownerSessionId` is not updated on parent migration.** The catalog
records the parent pi session id at thread creation
(`startWorker`/`createFreshThread`). When the user runs
`/chat-disconnect` followed by `/chat-connect <same-channel>` from a
different pi process, the `parentConversationId` stays valid but the
live parent pi session id changes. Nothing rewrites the catalog
`ownerSessionId`, so any later code that uses it points at a dead
session.

Today `ownerSessionId` is mostly vestigial; the supervisor and the
lifecycle commands match on `parentConversationId` instead, which is
stable across reconnect. But the field is on the catalog schema, so
future code that uses it will silently misbehave after a parent
migration. Either remove it from the catalog, or rewrite it whenever
the supervisor sees a different live parent session bound to the same
`parentConversationId`.

### Lifecycle notice posted before the restart actually happens

Status: fixed after 0.6.0. Existing-thread starts no longer post a
lifecycle notice before `startWorker` returns. `/chat-thread <name>` no
longer restarts an already-running worker; it reports `already-running`
and does not post a lifecycle notice.

`startOrAttach` used to post `"Restarting pi-chat thread <name>."` to
the thread Discord channel *before* `restartExistingThread` ran
`startWorker`. The post fired unconditionally on every `/chat-thread
restart <name>` and on every `/chat-thread <name>` against an existing
thread, regardless of whether the worker actually needed restarting.

This makes false positives indistinguishable from real restarts. Users
see the notice on every invocation and assume the worker is being
bounced when it is not. Two small fixes:

- Post the notice only after `startWorker` returns with
  `action: "restarted"`. For `"already-running"`, post a different
  (or no) notice. For `"started"` (cold start), keep the existing
  message.
- Tolerate the small UX regression that the user sees no message
  during the (sub-second) restart window. The fenced result block in
  the parent channel is already the authoritative confirmation.

### LLM echoes lifecycle notices back as plain text

Status: fixed after 0.6.0. Lifecycle notices now use Discord embeds with
a `Thread lifecycle` title, so a model echo is visibly different from a
real lifecycle notice.

The extension's lifecycle notices (`"Restarting pi-chat thread
<name>."`, `"Starting pi-chat thread <name>."`) used to be plain text
messages posted via `sendDiscordChannelMessage`. They landed in the
thread's Discord history, which the worker's LLM then saw as part of the
conversation transcript. When the LLM was asked a question in that
thread on a later turn, it sometimes echoed the same
`"Restarting pi-chat thread <name>."` line as its reply, because the
pattern was well-represented in recent context.

Observed 2026-06-05: every prompt in the
`infra-migrate-and-upgrade-sffpc` thread for ~15 minutes produced a
verbatim `"Restarting pi-chat thread infra-migrate-and-upgrade-sffpc."`
reply from the worker. The worker tmux session was healthy and
`recordCount` advanced normally; the extension was not actually
restarting anything. The user reasonably read this as a restart loop.

Fix shape, in increasing invasiveness:

- Wrap lifecycle notices in a Discord embed (with a title like
  `"Thread lifecycle"`). Embeds are structurally hard for the LLM to
  reproduce as a chat message, so an echoed plain-text version is
  distinguishable from a real one at a glance.
- Prefix lifecycle notices with a sentinel that is unlikely to appear
  in normal model output (a zero-width joiner sequence, a unique unicode
  glyph, or a `[pi-ez-chat-threads]` tag). Then the agent in the thread
  can be instructed not to repeat lines starting with that prefix.
- Add an opt-in bridge-side dedupe: collapse consecutive outbound
  posts in the same channel with identical text to one post.

The embed change is the cleanest and the only one that does not assume
the LLM cooperates.

### Recovering a stuck thread worker from before 0.4.2

If a thread was created with `pi-ez-chat-threads` < 0.4.2, its forked
session may have recorded the (then-nonexistent) channel workspace dir as
`cwd`. The worker then blocks at pi's interactive "cwd from session file
does not exist" prompt at startup, never starts the Discord listener, and
never replies in the thread.

0.4.2 fixes new threads. For existing stuck threads, from the parent
channel:

```text
@bot /chat-thread restart <name>
```

`restart` kills the wedged tmux worker and respawns against the recorded
session file. If the original session file still records the bad cwd, stop
the thread and start a new one with a different name:

```text
@bot /chat-thread stop <name>
@bot /chat-thread <new-name>
```
