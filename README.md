# pi-ez-chat-threads

`pi-ez-chat-threads` gives Discord users a simple way to turn a moment in a main `pi-chat` channel into its own long-lived pi session.

Use it when you want one Discord thread to become the durable home for one piece of work: the thread name is the session name, the thread keeps its own pi-chat-managed scratch workspace, and messages in that thread continue the same forked pi session history even after the main channel connects to something else.

## What you get

- `/chat-thread` slash command inside pi.
- Creates a named Discord thread under the currently connected pi-chat channel.
- Persists that thread in `~/.pi/agent/chat/config.json` as its own pi-chat conversation.
- Inherits host-repo mounts configured by `pi-ez-chat-mount` for the parent channel.
- Forks the current pi session into the thread worker session directory.
- Starts a dedicated tmux/pi worker for that thread.
- Reuses the same thread for the same source pi session by default, so a thread is a persistent place, not a disposable response.

## Install

Install both `pi-chat` and this package in the same pi environment:

```bash
pi install git:github.com/earendil-works/pi-chat
pi install git:github.com/bry-guy/pi-ez-chat-threads
```

If pi is already running, run `/reload` after installing.

Recommended companions: `pi-ez-chat-mount` for making your host repo available inside chat VMs, and `pi-ez-secret-broker` for secret-backed workflows.

## First-time Discord setup

This package builds on `pi-chat`; configure Discord there first:

1. Run `/chat-config`.
2. Add or select your Discord bot account.
3. Configure the main Discord channel where you talk to pi.
4. Run `/chat-connect <account/channel>`.

The Discord bot needs permission to create public threads and send messages in the channel.

## Create a persistent thread session

From a pi session that is already connected to a Discord pi-chat channel:

```text
/chat-thread Fix login tests
```

That does the whole handoff using the connected Discord channel as the parent:

1. Creates a Discord thread named `Fix login tests`.
2. Adds it to pi-chat config as a new conversation.
3. Inherits the parent channel's `pi-ez-chat-mount` mount configuration.
4. Forks the current pi session into that thread's worker session directory.
5. Starts a tmux worker connected to the thread.

Now talk in that Discord thread. It is its own continuous pi session. Forking from inside a managed thread is intentionally disallowed; run `/chat-thread` from the parent channel instead.

## Choose which pi session the thread continues

In interactive pi, `/chat-thread` asks which session should become the thread's history:

1. **Use current pi session** — the default, and usually what you want.
2. **Resume/use a different saved pi session** — pick from recent saved sessions without first switching the main chat connection.
3. **Use current connected worker session for the parent channel** — use the most recent pi-chat worker session for the selected parent channel, when one exists.

The Discord parent channel and the source pi session are separate choices. The parent channel decides where the Discord thread is created; the source session decides what history the thread continues.

## Create a thread from any pi session

You do **not** have to switch the main channel with `/chat-connect` just to create a thread. The current pi session is the default session that gets forked. In interactive pi, you can instead choose a different saved session or the parent channel worker session. The connected pi-chat context is only used to choose the Discord parent channel.

If your current pi session is not connected to pi-chat, pass the parent channel explicitly:

```text
/chat-thread Fix login tests --parent=my_bot/dev
```

If you omit `--parent` in interactive pi, the command lets you choose from configured Discord channels.

This means the workflow can be either:

- hop main chat with `/chat-connect`, then `/chat-thread`; or
- stay in any local/resumed pi session and run `/chat-thread --parent=<account/channel>`.

## Default thread name

If you omit the name:

```text
/chat-thread
```

The package uses the current pi session name if one exists. Otherwise it falls back to a short session id such as `pi 019e52eb`.

## Reuse is intentional

Run `/chat-thread` again from the same source pi session and it returns the existing thread instead of creating a duplicate.

Use this when you want to find the durable thread for the current session:

```text
/chat-thread
```

If you really want another thread from the same source session:

```text
/chat-thread Another branch --new
```

## Command reference

```text
/chat-thread [thread name] [--parent=<account/channel>] [--new] [--restart] [--no-spawn]
```

Flags:

- `--parent=<account/channel>`, `--channel=<account/channel>` — Discord pi-chat channel under which to create the thread. Optional when already connected to pi-chat.
- `--new` — create another thread instead of reusing this session's existing persistent thread.
- `--restart` — restart the thread worker if it is already running.
- `--no-spawn` — configure and fork the session but do not start tmux.


## Worker options

Restart the thread worker if it already exists:

```text
/chat-thread Fix login tests --restart
```

Create/configure/fork the thread but do not spawn tmux:

```text
/chat-thread Fix login tests --no-spawn
```

You can later start workers through pi-chat, or run the emitted session/conversation manually.

## Use from Discord

When this package is loaded in the pi-chat worker, Discord users can send the same command in chat:

```text
/chat-thread Fix login tests
```

pi-chat forwards that text to pi; this package intercepts it before the agent treats it as a normal prompt, creates the thread, and asks the agent to report the result back. This works best from a connected Discord pi-chat channel because the current chat connection supplies the parent channel.

For now, this is implemented as a pi extension input hook rather than a native pi-chat remote command registry. Native third-party remote commands would require a small upstream pi-chat extension point.

## Mounts

`pi-ez-chat-threads` no longer copies the parent channel `/workspace` into the thread. The thread's `/workspace` remains pi-chat-managed scratch for memory, incoming files, skills, and agent-written files.

If you want your local repo available in the thread VM, install/use `pi-ez-chat-mount` in the parent channel first. When a thread is created, this package copies the parent's entries from `~/.pi/agent/chat-mount/mounts.json` to the new thread conversation id, preserving guest paths and `rw`/`ro` modes. Re-running `/chat-thread` for an existing thread re-syncs mounts from the current parent state.

`pi-ez-chat-handoff` has been deleted and is not the path for “use my local repo from chat”; use `pi-ez-chat-mount` instead.

## Main channel versus thread sessions

The intended workflow is:

1. Main Discord channel is your switching board.
2. `/chat-connect` changes what the main channel controls.
3. `/chat-thread <name>` creates a named persistent thread from the current context.
4. The new thread keeps its own continuous pi worker/session.
5. You can reconnect the main channel somewhere else without disturbing existing threads.

So the main channel can be transient while threads are durable historical chat contexts.

## Storage layout

A thread is stored exactly like a pi-chat channel under `~/.pi/agent/chat/`:

```text
accounts/<account>/channels/<thread-key>/workspace/
tmux-sessions/pi-chat-worker-<account>_<thread-key>/
```

The config entry includes extra metadata such as `parentConversationId`, `parentChannelId`, and `managedBy`. pi-chat ignores unknown fields, but this package uses them to make thread sessions understandable and recoverable.

## Limitations

- Discord only for now.
- Creates public threads using Discord's REST API.
- Assumes the bot has thread creation permissions.
- Does not yet discover old manually-created Discord threads.
- Live end-to-end testing requires a real Discord bot/server; automated tests mock the Discord API and tmux spawn.

## Development

```bash
npm ci
npm run check          # typecheck + smoke tests
npm pack --dry-run     # inspect publishable files
```

The smoke tests cover extension registration, Discord API payloads, pi-chat config mutation, mount inheritance, session forking, and worker command generation.

## Related packages

- [`pi-chat`](https://github.com/earendil-works/pi-chat) — chat transport and conversation workspaces.
- [`pi-ez-chat-mount`](https://github.com/bry-guy/pi-ez-chat-mount) — host-repo mounts inherited by new threads.
- [`pi-ez-secret-broker`](https://github.com/bry-guy/pi-ez-secret-broker) — companion secret workflow support.
