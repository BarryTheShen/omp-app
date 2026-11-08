# Install omp app

This page covers installing, starting, updating and removing omp app on Linux. To open the app from your phone or another computer afterwards, see [Other devices](devices.md).

## What do I need?

- **A 64-bit x86 (amd64) Linux computer that installs `.deb` packages.** The app is used and tested on Ubuntu with GNOME. The window needs glibc 2.39 or newer, which Ubuntu 24.04 has; its package declares that dependency.
- **systemd's user manager,** if you want the server to start at login. The terminal command's package installs a user service for it (see [How does the user service work?](#how-does-the-user-service-work)).
- **Nothing else for omp.** Both packages hold the omp release the app is built for, as the app's chat host: omp's own command line, compiled from the pinned package. Every chat and every omp command runs on it. An omp installed on your computer is never used to run chats, and nothing is downloaded. Your own omp settings and chats (the files under `~/.omp`) are shared with the app: its chats run omp on them.

Each release has two packages of the same version:

| Package | Take it if you want | What it installs |
|---|---|---|
| `omp-app-desktop_<version>_amd64.deb` | the app in a window of its own, opened from the applications menu | The window `omp-app-desktop`, the server it starts (`omp-app-desktop-server`), the chat host and the web app under `/usr/lib/omp-app-desktop`, and the applications-menu entry "omp app", which also offers "New Window" |
| `omp-app_<version>_amd64.deb` | the app in your browser, started from a terminal or at login | The command `omp-app`, the chat host (`/usr/lib/omp-app/chat-host`), the web app (`/usr/share/omp-app/ui`), the user service `omp-app.service`, an icon, and a menu entry "omp app" that runs `omp-app` in a terminal window |

The two packages share no file, so you can install both. Both recommend `xdg-utils` (it opens your browser). The terminal command's package also recommends `tmux`, which `omp-app tui` needs (see [Using the app](using.md#omp-in-the-terminal-on-the-same-chats)), and the window's package recommends `gstreamer1.0-tools`. apt installs recommended packages unless you tell it not to.

Two features need something more, and neither is needed to chat:

- The Browser panel's own browser needs Google Chrome or Chromium (see [Configuration](configuration.md#environment-variables)).
- Opening the app from other devices needs [Tailscale](https://tailscale.com) (see [Other devices](devices.md)).

## Where do I download it?

Releases are built from `main` and published on the [releases page](https://github.com/BarryTheShen/omp-app/releases). A release is named "omp app" followed by its version (`0.3.` and a number that only goes up), and holds both packages and one `SHA256SUMS` file. The scheduled build runs twice a day and releases only when something in the product changed since the last release; see [Releasing](releasing.md).

With the GitHub command line, one command downloads both packages and the checksums:

```bash
gh release download --repo BarryTheShen/omp-app --pattern '*.deb' --pattern SHA256SUMS
```

Without it, download the files from the releases page in your browser.

Check them before you install. `SHA256SUMS` lists the checksum of both packages; `--ignore-missing` skips the one you did not download:

```bash
sha256sum -c --ignore-missing SHA256SUMS
```

Each package you downloaded must print `OK`.

## How do I install it?

Give apt the path of the file, starting with `./`, so it installs the local package and its dependencies:

```bash
sudo apt install ./omp-app-desktop_<version>_amd64.deb   # the window
sudo apt install ./omp-app_<version>_amd64.deb           # the terminal command
```

Replace `<version>` with the version in the file name. Then:

- **The window:** open "omp app" from the applications menu, or run `omp-app-desktop`.
- **The terminal command:** run `omp-app`. It opens the app in your browser.

If you installed both, the menu has two entries named "omp app". The window's one opens a window; the command's one opens a terminal that runs `omp-app`.

## What happens the first time I start it?

**The window** opens at once on a starting page that says "Starting omp app". This can take a few seconds, and up to a minute the first time. If a server is already running for your account, the window opens the app on it. Otherwise the window starts one on your home folder, in a session of its own, and opens the app when it answers. Closing the window never stops that server, so running chats keep going.

**The terminal command** starts the server in the terminal, prints a link and opens it with `xdg-open`:

```text
omp app <version>

  http://127.0.0.1:4317/#token=<token>

Press Ctrl+C or close this window to quit.
```

If no browser opens by itself, the command says so: open the address it printed. The secret after `#token=` signs your browser in. The page keeps it for its tab and takes it out of the address bar. Ctrl+C, or closing the terminal, stops the server, and the chats it was running stop with it.

The link opens the app on this computer only, and it stays the same when the app restarts or the computer reboots. The app keeps the token in a file that only your account can read, `~/.local/state/omp-app/launch-token` (under `$XDG_STATE_HOME/omp-app` instead when that variable is set to an absolute path). Every other device pairs once instead; see [Other devices](devices.md).

If the app is already running, `omp-app` prints "omp app <version> is already running." with the running server's version and its link, and opens the browser on it. `omp-app --no-open` prints the link without opening a browser, which is how you get it again when the service started the app. `omp-app <folder>` opens the running app on that folder.

If omp cannot start, the terminal prints a warning, and chats say why they could not open. See [Troubleshooting](troubleshooting.md#omp-cannot-start-or-has-no-model).

## How does the user service work?

The terminal command's package installs the user service `omp-app.service` and turns it on for every user (`systemctl --global enable`). From each user's next login, the app's server runs in the background with no window or browser open, so chats keep running. The service runs `/usr/bin/omp-app --no-open %h`: the app on your home folder, with the browser left alone. It restarts only after a failure (`Restart=on-failure`).

Starting it right after the install, without logging out:

```bash
systemctl --user start omp-app
```

Everyday commands, all run as your own user and without `sudo`:

```bash
systemctl --user status omp-app          # is it running? when did it start?
systemctl --user stop omp-app            # stop it until the next login
systemctl --user restart omp-app         # stop and start it again
systemctl --user mask --now omp-app      # stop it and keep it from starting at your logins
systemctl --user unmask omp-app          # undo the mask; it starts again at your next login
journalctl --user -u omp-app             # what the server printed to the service's output
omp-app logs                             # the app's own log: where it is, and its last 100 lines
```

Use `mask` and not `disable` to keep it from starting: the package turned the service on for every user, which a single user cannot disable. `unmask` undoes it. Removing the package turns the service off for everyone.

To check that the app is up, run `systemctl --user status omp-app`, or run `omp-app --no-open`: it prints "is already running" and the link when the server answers, and starts one in your terminal when none does.

To give the service environment variables, such as the address for other devices, see [Configuration](configuration.md#how-do-i-set-variables-for-the-user-service).

## How do I update it?

Download and check the new packages the same way as the first time, then install them over the old ones:

```bash
sudo apt install ./omp-app-desktop_<new version>_amd64.deb   # the window, if you use it
sudo apt install ./omp-app_<new version>_amd64.deb           # the terminal command, if you use it
```

An upgrade keeps the service turned on. It does not restart a server that is running: the server in memory stays the old release until it stops, while the files on disk (the web app and the chat host) are already the new ones. Restart it to bring them together:

- **The service runs it:** `systemctl --user restart omp-app`.
- **You started it in a terminal with `omp-app`:** press Ctrl+C in that terminal, then run `omp-app` again.
- **The window started it:** the window never stops its server. End the server's process, then open the window again. The record of the running server is `~/.local/state/omp-app/instance.json` (readable by your account only), and `jq` reads the process id from it:

  ```bash
  kill "$(jq .pid ~/.local/state/omp-app/instance.json)"
  ```

To see which release runs: `omp-app --version` prints the installed command's version, and `omp-app` (or `omp-app --no-open`) prints the version of the server that is running.

**Do running chats survive an update?** Not by default. A restart stops the server, and the server stops each chat's omp process with it. A reply that omp was writing is cut off. Nothing already written is lost: every chat is in omp's own session files, it stays in the chat list, and opening it starts omp on it again. Restart when no chat is working, and use Pause on the ones that are (see [Using the app](using.md#pause-a-chat)).

There is one exception, and it is off by default. When `OMP_APP_DETACHED_HOSTS=1` is set for the server, each chat runs in a host process that outlives the server: in its own systemd user scope when your user's service manager answers, otherwise in a session of its own. Stopping or restarting the service then stops no chat. The restarted server takes over the hosts it can serve. A host on another chat-host protocol is asked to hand its chat back, and a host on an older build is restarted once its chat is idle. A host whose server stays away for two minutes hands its chat back once the chat is idle, so that `omp-app tui` can open it. See [Configuration](configuration.md#environment-variables) for the variable and for `OMP_APP_HANDBACK_MS`, and [Architecture](architecture.md#chats-that-outlive-the-server) for how a server takes hosts over.

Pages you already had open keep running the old web app until they reload. After the server restarts, such a page shows "The app was updated. Reload to use the new version." with a Reload button, which reloads the page and shows the same chat again. The page checks when its connection opens again, when you come back to it, and every 10 minutes.

## How do I uninstall it?

Stop a server that is running first. Removing a package does not stop one:

```bash
systemctl --user stop omp-app
```

Then remove the package or packages:

```bash
sudo apt remove omp-app           # the terminal command: removing it turns the user service off for everyone
sudo apt remove omp-app-desktop   # the window: it also removes the omp it bundled
```

Removing the window's package leaves the terminal command's alone, and the other way round. If the window had started the server, end it as described under [How do I update it?](#how-do-i-update-it).

Removing a package leaves your folders in place. To undo the removal, install the package again: your chats, settings and paired devices are still there. To delete the app's own files as well, see the next section.

## Where does the app keep its files?

| Folder | What is in it |
|---|---|
| `/usr/bin`, `/usr/lib/omp-app`, `/usr/lib/omp-app-desktop`, `/usr/share/omp-app`, `/usr/lib/systemd/user` | What the packages install: the commands, the chat host, the web app and the service file. `apt remove` takes them away. |
| `~/.local/state/omp-app` | The app's log, the launch token and the record of the running server. |
| `~/.omp/agent/app` | The app's own data: drafts, the paired devices, model preferences and more. |
| `~/.config/omp-app` | The server addresses the window keeps. |
| `~/.local/share/omp-app/desktop-window` | The window's own web data, such as its pairing key and its page settings. |
| `~/.omp/agent` | Not the app's: omp's own folder, with its settings file (`config.yml`) and every chat. The app's chats run omp on it, so omp's terminal uses the same files. |

[Configuration](configuration.md#where-does-the-app-keep-its-data) says what each of the app's folders holds, and which variables move them.

To delete the app's own files after removing it, remove the four folders that belong to it. This forgets the paired devices, the drafts and the window's settings; omp's folder is left alone, so your chats stay:

```bash
rm -r ~/.local/state/omp-app ~/.omp/agent/app ~/.config/omp-app ~/.local/share/omp-app
```

Do not remove `~/.omp/agent`, unless you mean to delete omp's settings and all your chats too.
