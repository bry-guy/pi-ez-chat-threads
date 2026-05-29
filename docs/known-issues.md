# Known issues

## 1. Upstream pi-chat `/new` does not actually start a new pi session

When a Discord user sends `@bot /new`, three things happen and only the first two actually work:

1. pi-chat's host process detects `new` as a control command (`ConversationRuntime.parseControlCommand`) and immediately replies "Starting a new pi session" to Discord.
2. The same inbound Discord message is appended to the conversation transcript so the worker sees a normal transcript turn containing `<@bot> /new`.
3. pi-chat tries to actually start the new session by calling, on the worker side:
   ```ts
   pi.sendUserMessage("/chat-new", { deliverAs: "followUp" });
   ```

Step 3 silently fails to invoke the registered `chat-new` command. `sendUserMessage` calls `agent-session.prompt(text, { expandPromptTemplates: false, source: "extension" })`, and `prompt()` only matches registered extension commands when `expandPromptTemplates` is `true`:

```ts
// node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js
if (expandPromptTemplates && text.startsWith("/")) {
  const handled = await this._tryExecuteExtensionCommand(text);
  ...
}
```

So `/chat-new` falls through the `input` hook pipeline as a plain user message, the LLM has no `chat_new` tool, and the agent responds with something like:

```text
I received /chat-new as plain text here. No chat_new tool/command is exposed to me inside this VM.
```

### Symptom on Discord

The Discord channel shows the friendly "Starting a new pi session" because that comes from the host-side step 1. But the worker is not actually reset; the next message in the channel goes to the same old session.

### Where this lives

- Upstream pi-chat call site: `index.ts` near line 736 (`pi.sendUserMessage("/chat-new", { deliverAs: "followUp" })`).
- Upstream gate that drops the command: `pi-coding-agent` `agent-session.js`'s `prompt(text, options)` guarded by `expandPromptTemplates && text.startsWith("/")`.
- Registered command: `pi.registerCommand("chat-new", ...)` in pi-chat's `index.ts`.

### Why we are not patching around this in pi-ez

The clean fix is upstream. We have two upstream-friendly options that pi-chat owns:

1. In pi-chat, replace the `sendUserMessage("/chat-new", ...)` inject with a direct call to `ctx.newSession({ parentSession: ..., setup: bind pi-chat-state })`. This is essentially what the `chat-new` command handler already does — pi-chat should call it directly instead of round-tripping through a fake user message.
2. In `pi-coding-agent`, have `prompt()` (or `sendUserMessage()`) still consult registered extension commands for slash-prefixed text even when `expandPromptTemplates` is `false`. Today's check intentionally couples command dispatch to template expansion, which is too coarse.

We could intercept `/chat-new` in our `input` hook (when `event.source === "extension"`) and call `ctx.newSession()` ourselves. We choose not to:

- `/chat-new` is pi-chat's command, not ours. Silently shadowing it from a sibling extension is hostile to future pi-chat changes and confusing for users debugging which extension owns which behavior.
- The pi-chat metadata required to keep the worker bound to the conversation (currently a `pi-chat-state` custom entry with `conversationId`) is also a pi-chat-private contract. Re-implementing it in a third-party extension means we have to track every internal change.
- Our other "fragile until upstream lands" workarounds (`VM.create` wrapping in `pi-ez-chat-mount` and `pi-ez-chat-git`) at least sit on the documented Gondolin API surface. A `/chat-new` reimplementation would not.

So we document and wait. File an upstream issue with the receipt above when you want this fixed.

## 2. Threads add lifecycle on top of pi-chat conversations, not on top of pi-chat itself

`pi-ez-chat-threads` does not extend pi-chat's session/VM model. A "thread" is mechanically just another pi-chat conversation (`<accountId>/<channelKey>`) registered in `~/.pi/agent/chat/config.json` with extra metadata (`managedBy: "pi-ez-chat-threads"`, `parentConversationId`). We add:

- a Discord thread creation step,
- mount inheritance at fork time (via `~/.pi/agent/chat-mount/mounts.json`),
- a fork of the parent's pi session into the thread's worker session directory,
- a lifecycle catalog at `~/.pi/agent/chat-threads/threads.json`.

Mounts do not propagate to existing threads after creation. By design: a thread's VM should be a stable, named environment, not a moving target.

## 3. Reload still relies on `@bot /new`

There is no extension API for restarting the current pi-chat sandbox from inside the VM. `pi-chat` parses `/new` in the host bridge before the worker's `input` hooks fire, so no third-party extension can intercept it cleanly. The supported reload action is `@bot /new` in the channel, with the upstream caveat in section 1 above. Until that lands, `pi-ez-chat-mount` and `pi-ez-chat-git` print a reload hint instead of registering a stub command.
