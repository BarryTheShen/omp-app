# Agent access

Agent access lets the app's chats run commands on another computer of yours (a laptop, a second machine) while you
allow it, over the app's own connection. This page says how to set it up and use it. How it works inside, and the
command line, are in [apps/device/README.md](../apps/device/README.md).

## What does it allow, and what keeps it safe?

- **Off by default, turned on only at the computer itself,** with your password, for up to eight hours. Any page of the
  app, the computer's tray icon or `omp-app-device off` turns it off; so does locking the screen or the computer going
  to sleep. The app's server can never turn it on.
- **Only the chats you allow.** A chat that has not been allowed is refused, and you are asked. Each allowed chat is
  listed in the Agent access panel, where Remove takes its access away.
- **A separate account.** Agents work as the `omp-agent` account, which cannot read your files. A folder of yours is
  reachable only once you share it.
- **Nothing listens on a port.** Each session is started for that session only, over the app's connection.
- **You can see it.** While access is on, the computer shows a red tray icon and a notification; each command is
  written to your open terminals and shown live in the panel. Every request, session, notification and password
  dialog names the chat it comes from, and the server it is on.
- **Sudo only when you allow it,** for at most 30 minutes, with your password again.

## How do I set it up?

On Linux, with the desktop window installed on the computer the agents should reach:

1. Open the app in the window, then the **Agent access** panel in the right side bar.
2. Click **Set up agent access** and give an administrator's password. The computer is linked to the server the
   window shows.
3. The server must offer agent access: it runs with `OMP_APP_DEVICE_ACCESS=1` and its HTTPS address
   ([configuration.md](configuration.md#environment-variables)).

A computer without the desktop window, and the `ssh` setting on the app's server, are in
[apps/device/README.md](../apps/device/README.md#install). On macOS and Windows the panel says agent access is Linux's
for now.

## How do I use it?

In the Agent access panel, under **This computer**:

| To | Do |
|---|---|
| Turn it on | **Turn on for** 30 min, 1 h, 2 h, 4 h or 8 h (your password) |
| Give a chat access before it asks | **Give a chat access**: pick the chat (the one open beside the panel comes first, as "This chat", then the workspace's recent chats), then **Give access** |
| Share a folder before it is asked for | **Share a folder**: type its path (`~/projects/app` or a full path), then **Share, reading only** or **Share, reading and changes** |
| Answer a chat's or a folder's request | The request in the panel (its notification opens the panel): **Allow** (or **Allow reading only**) asks your password; **Deny** |
| See what runs | **Agent sessions on this computer**, each named by its chat |
| Stop a chat or a folder | **Remove** beside it in the lists of chats and shared folders |
| Turn it off | **Turn off**, or the tray icon |

Shared folders and allowed chats stay until you remove them; they only work while access is on.

## What does a chat see?

A chat reaches the computer with `ssh <computer>` on the app's server. Its first try is refused ("its owner was
asked"). A chat never waits for you: your answer comes into the chat as a notice, headed **Agent access**, when the chat
is free, and the chat goes on from there. The same happens when you deny a request, take a chat's access away or give
it access yourself.

For one of your folders, the agent runs `omp-app-device ask-folder '~/<folder>' [--write] --why '<one line>'` on the
computer. A folder shared already is printed at once (where it is mounted, under `/run/omp-app-device/shared/`);
otherwise the command ends at once (exit code 3), and your answer, with the folder's place once allowed, comes as a
notice too.

## What is kept?

Each command line, its times and exit code, signed by the computer, listed in the panel's activity and kept in the
computer's own log (`/var/log/omp-app-device`, two years). What a session prints is shown live on the computer only.
Recording is a view, not a cage; the protection is the separate account, the time limit and the off switch
([apps/device/README.md](../apps/device/README.md)).
