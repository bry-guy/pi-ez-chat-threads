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
