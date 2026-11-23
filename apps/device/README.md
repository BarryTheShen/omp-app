# omp-app-device: agent access to your computers

Lets the app's agents run commands on another computer of yours, over the app's own connection, while you allow it.

- **Off by default, on only from the computer.** You turn access on from the computer itself (its Agent access
  window, or `omp-app-device on` in any login of yours there, ssh too), with your own password, for up to eight hours.
  Any page of the app, the computer's tray icon or `omp-app-device off` turns it off. It also turns off by itself when
  the screen locks or the computer goes to sleep (read from logind with `gdbus`, part of GLib's tools). The app's
  server can never turn it on.
- **No port.** Nothing listens on port 22 or on any other port. Each agent session is one `sshd -i` started by the
  guard for that session only, over the app's connection.
- **You can see it.** While access is on, the computer shows a red tray icon and a notification. Each session's
  command is written to your open terminals. The Agent access panel in the desktop app's side bar (and
  `omp-app-device watch`) shows each command and what it prints as it runs.
- **A separate account.** Agents work as the `omp-agent` account, never as you. When a session changes that account's
  startup files, the guard blocks the next session; at every off it ends every process of the account and removes its
  startup files, `~/.ssh`, autostart entries, user units, scheduled jobs and its files in the shared temporary folders.
- **Sudo only when you allow it**, for the agent account, for at most 30 minutes, with your password again (the dialog
  says it is for root). What runs as root ends when the grant ends. As root a session could change anything, so after
  an access with sudo the next turn-on waits until you have looked the computer over (`omp-app-device acknowledge`).
- **What is kept:** each command line (a command over 4,000 characters is cut, with its length and checksum), its
  times and exit code; an interactive shell or a file copy is one record each. The computer signs each record; the
  Agent access panel in the app lists them, and the computer's own log keeps them too.
- **What is shown live, on the computer only:** what each session prints, and for a file copy each file it opens,
  writes, removes or renames. Not kept.
- **What recording cannot catch.** A session runs as the same account as its recorder, so recording is a view, not a
  cage: a script fed on standard input (`ssh my-laptop 'sh -s' < script`) is recorded as `sh -s`; typing with echo off
  shows nothing; a session can stop its recorder or start a process that keeps running until off; and it can report
  false output for its own runs. The protection is the separate account, the time limit and the off switch.

## Parts

| Part | Runs as | What it does |
|---|---|---|
| `omp-app-device setup` / `remove` | root (pkexec or sudo) | Makes the computer ready for agent access, or undoes it |
| `omp-app-device guard /etc/omp-app-device/guard.json` | root (system service) | Starts each session's `sshd -i` as `omp-agent` in `omp-agent-access.slice`, enforces the deadline, writes the log, grants and removes sudo |
| `omp-app-device wrapper` | `omp-agent` (sshd's `ForceCommand`) | Runs the session's command and records it; refuses to run anything it cannot record |
| `omp-app-device run` | you (user service) | The link to the app's server, the switch, the notices |
| The desktop app's Agent access panel (side bar) and tray | you | Set up, turn on, turn off, sudo, the live view, remove |

The program, OpenSSH's server programs (unpacked from Ubuntu 24.04's packages; never installed as a service, so
nothing listens on port 22), the units and the polkit actions live in `/usr/lib/omp-app-device`, `/usr/lib/systemd` and
`/usr/share/polkit-1`. They come with the desktop app's package, or, on a computer without the desktop app, with the
`omp-app-device` package. Installed, they are idle: no account, no service, no port, until setup.

## Install

**With the desktop app:** install the app, open the **Agent access** panel in the app's right side bar and click **Set
up agent access on this computer**, then give an administrator's password. That is all: setup runs, and the computer is
linked to the server that window shows (the desktop app takes a one-time code from that server and the address from its
own record of the window). Setup:

- makes the `omp-agent` system account (home `/var/lib/omp-agent`, shell `/bin/sh`, which reads no startup files) and
  adds it to `/etc/cron.deny` and `/etc/at.deny`;
- makes the computer's host key (`/etc/omp-app-device-host/`; its private half readable by `omp-agent` and root only)
  and the guard's settings (`/etc/omp-app-device/guard.json`, naming you as the person);
- enables and starts the guard, then your agent;
- checks what a turn-on checks and says plainly what to fix: a home folder other accounts can open (`chmod 750 ~`), an
  ssh server of this computer's own that would let `omp-agent` log in past the guard (add `DenyUsers omp-agent` to its
  settings, or stop it), a missing polkit or gdbus. It changes none of these itself.

**On a server** (no desktop app):

```sh
sudo apt install ./omp-app-device_<version>_amd64.deb
sudo omp-app-device setup                 # as you: sudo names you as the person
sudo loginctl enable-linger "$USER"       # your agent runs while you are not logged in (undo: disable-linger)
```

**On a server, then: enroll it with the app's server.** The server needs `OMP_APP_DEVICE_ACCESS=1` and its https
address. In the app, open Settings → App → Devices → New code, then on the computer run:

```sh
omp-app-device enroll https://your-server.example my-laptop
```

and type the code. The server pins the computer's host key and its signing key.

**On the app's server, once:** add this line at the top of the server account's `~/.ssh/config`, so its agents can run
`ssh my-laptop`:

```
Include /run/user/<uid>/omp-app-access/ssh_config
```

(`<uid>` is the server account's user id: `id -u`.)

## Use

| | Desktop app | Command line |
|---|---|---|
| Turn on (asks your password) | Agent access panel → Turn on for 30 min, 1 h, 2 h, 4 h or 8 h | `omp-app-device on [--for <minutes>]` (default 120, at most 480) |
| Turn off | Tray → Turn off, or the panel on any device | `omp-app-device off` |
| More time (asks your password) | Panel → Extend by 15 min, 30 min or 1 h; tray → Extend 1 h | `omp-app-device extend [--for <minutes>]` |
| Sudo for the agent account (asks your password) | Panel → Allow sudo for 5, 15 or 30 min; tray → 30 min | `omp-app-device sudo [--for <minutes>]` |
| What runs now | The panel → Agent sessions on this computer | `omp-app-device watch` |
| State, and what changed last time | The panel | `omp-app-device status` |
| Reviewed what changed | The panel → Mark as reviewed | `omp-app-device acknowledge` |
| Let a chat in (asks your password) | The chat's request → Allow; or Give a chat access | `omp-app-device allow-chat <chat id>` (`status` lists requests) |
| Share a folder (asks your password) | The folder's request → Allow; or Share a folder | `omp-app-device allow-folder <id> [--write]` |
| Turn a request down | Deny | `omp-app-device deny-chat <chat id>`, `deny-folder <id>` |
| Take a chat's access, or a folder, away | Remove beside it | `omp-app-device remove-chat <chat id>`, `remove-folder <path>` |

**Chats and folders.** Only chats the person allowed reach the computer: a chat's first `ssh` is refused, the person is
asked (a notification that stays, and the panel), and their answer goes into that chat as an `agent-access` notice
through the server, so the chat never waits or retries. The agent account cannot read the person's files; an agent asks
for a folder with `omp-app-device ask-folder '~/<folder>' [--write] --why '<one line>'`, which prints a folder shared
already (exit 0) and otherwise exits 3 at once, the answer coming as a notice too. A shared folder is mounted under
`/run/omp-app-device/shared/` while access is on. Every request, session, notification and password dialog names the
chat it comes from (the name the server gave the session); a shared folder records the chat that asked, or that the
person shared it. The allowed chats are in `chat-grants.json` in the agent's data folder; the shared folders in
`/var/lib/omp-app-device` (the guard's state folder).

## Remove

The Agent access panel → **Remove agent access from this computer** (an administrator's password), or
`sudo omp-app-device remove`, or removing the package: access turns off, the guard stops, and the `omp-agent` account,
its home, the settings, the host key, any sudo grant and the deny lines go. The access log
(`/var/log/omp-app-device`, kept two years) and a pending review (`/var/lib/omp-app-device`) stay, as the record of
what agents did, until the package is purged (`sudo apt purge`). An `omp-agent` account that setup did not make is left
alone, with its home, and Remove says so. Moving from the desktop app's package to `omp-app-device` (or back) removes
the installed one first, so it removes agent access too: set it up again afterwards. The app's Agent access panel → the
computer → Remove forgets it on the server.

## Tests

`bun test` in `apps/device`. Real-sshd tests need an unpacked OpenSSH folder (`OMP_APP_DEVICE_TEST_OPENSSH`, holding
`usr/sbin/sshd`, `usr/lib/openssh/` and libwrap) and a scratch folder that sshd's StrictModes accepts
(`OMP_APP_DEVICE_TEST_DIR`, mode 700, not under `/tmp`). The sudo drop-in's check needs sudo-rs's `visudo`
(`OMP_APP_DEVICE_TEST_VISUDO`, which checks a file without root). Without these, those tests are skipped. Run them
with the OpenSSH the packages bundle (24.04's, from its `openssh-server` and `openssh-sftp-server` packages) as well as
a newer one: the guard writes OpenSSH 10's `sshd-session` and `sshd-auth` settings only when they exist.
