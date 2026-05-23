# pi-ez-chat-threads

`pi-ez-chat-threads` gives Discord users a simple way to turn a moment in a main `pi-chat` channel into its own long-lived pi session.

Use it when you want one Discord thread to become the durable home for one piece of work: the thread name is the session name, the thread keeps its own pi-chat workspace, and messages in that thread continue the same forked pi session history even after the main channel connects to something else.

## What you get

- `/chat-thread` slash command inside pi.
- Creates a named Discord thread under the currently connected pi-chat channel.
- Persists that thread in `~/.pi/agent/chat/config.json` as its own pi-chat conversation.
- Seeds the thread workspace from the current channel workspace.
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

That does the whole handoff:

1. Creates a Discord thread named `Fix login tests`.
2. Adds it to pi-chat config as a new conversation.
3. Copies the current channel workspace into the thread workspace if it is empty.
4. Forks the current pi session into that thread's worker session directory.
5. Starts a tmux worker connected to the thread.

Now talk in that Discord thread. It is its own continuous pi session.

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

The smoke tests cover extension registration, Discord API payloads, pi-chat config mutation, workspace seeding, session forking, and worker command generation.
