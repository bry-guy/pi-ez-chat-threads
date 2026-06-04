# pi-ez-chat-threads

## What it does

Turns a Discord thread into a named, persistent pi-chat conversation that branches off a parent channel.

## Why it exists

Working on several things in one channel gets messy. Threads let you fork a parent conversation into focused, parallel side conversations that each run their own agent worker.

## How to use it

New to pi-ez-chat? Start with the [user guide](https://github.com/bry-guy/pi-ez-chat-workspace/blob/main/docs/user-guide.md).

Install:

```text
pi install git:github.com/earendil-works/pi-chat
pi install git:github.com/bry-guy/pi-ez-chat-threads
```

If pi is already running, run `/reload` after installing.

You need a connected pi-chat parent channel (`/chat-connect ...`) and a Discord bot allowed to create public threads.

Common commands. They work the same from a pi session and from Discord.

- `/chat-thread start <name>` creates a new thread under the parent channel, or attaches to an existing one with the same name. Bare `/chat-thread <name>` is shorthand.

  ```text
  /chat-thread start fix-bug-123
  /chat-thread fix-bug-123
  ```

  A new thread inherits the parent's mounts and git config at creation time, then runs in its own tmux worker.

- `/chat-thread stop` stops the current thread's worker without deleting anything. Use `/chat-thread stop <name>` from the parent channel.

  ```text
  /chat-thread stop
  /chat-thread stop fix-bug-123
  ```

- `/chat-thread list` lists managed threads for the connected parent channel and shows worker status.

  ```text
  /chat-thread list
  ```

- `/chat-resume` opens a local picker that resumes a dormant thread session in your current desktop pi. Pass a name to resume directly.

  ```text
  /chat-resume
  /chat-resume fix-bug-123
  ```

`/chat-thread restart <name>` and `/chat-thread kill <name>` cover the restart and destructive cleanup cases. `rename` updates the catalog, the pi-chat conversation config, and the Discord thread name.

## Notes

- Threads inherit mounts and git config at creation time. Later parent changes do not propagate to existing threads.
- A stopped tmux worker is only a dormant runner. The Discord thread, pi session file, mounts, and git config remain durable.
- A parent-channel supervisor watches managed threads, suspends idle workers, and wakes them when a new user message arrives. Configure with `PI_EZ_CHAT_THREADS_SUPERVISOR=*` environment variables; see the source for the full list.
- Workspace and threads work well together. Bind the parent channel to a workspace, and threads pick up the same setup.
