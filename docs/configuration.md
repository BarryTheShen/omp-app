# Configuration

This page lists everything you can give the app from outside: the options of the `omp-app` and `omp-app-desktop` commands, the environment variables, the folders and files it keeps, and the omp settings it reads or changes. Settings you change inside the app are in [Using the app](using.md#settings).

## What does the `omp-app` command take?

```text
omp-app [folder] [options]
omp-app tui [folder] [-- omp's options]
omp-app pair
omp-app devices [remove <device>]
omp-app logs [--lines <n>]
omp-app debug-report
```

`omp-app --help` prints the same summary.

### Starting the app

`omp-app [folder] [options]` starts the app's server, prints its link and opens your browser on it. If the app is already running for your account (for example, started by the user service), it prints that instance's link and opens the browser on it instead; with a `folder` it opens the running app on that folder.

| Argument | What it does |
|---|---|
| `folder` | The folder to work in. The default is the current folder. The command stops with `"<path>" is not a folder.` when the path is not a folder. A folder named like a command (`tui`, `pair`, `devices`, `logs` or `debug-report`) is written with `./` in front, for example `./logs`, because those words are commands when they come first. |
| `--port <n>`, `--port=<n>` | The port to listen on, from 0 to 65535. The default is 4317, or `OMP_APP_PORT` when that is set. With 0 the system picks a free port. When the port is busy and you did not give `--port`, the app says "Port 4317 is in use; using a free one." (with the port it tried) and takes a free one. When you did give `--port`, it stops with "port N is in use. Pick another with --port." |
| `--no-open` | Starts without opening your browser. The user service uses this. |
| `-v`, `--version` | Prints the version and exits. |
| `-h`, `--help` | Prints the usage and exits. |

The server listens on 127.0.0.1 only, whatever the port. `--lines` does something only with `logs`. Any other option stops the command with "Unknown option", and a second folder with "Only one folder can be given."

### Subcommands

| Command | What it does |
|---|---|
| `omp-app tui [folder] [-- omp's options]` | Opens omp's own terminal app in the folder (default: the current one), on the app's chats, inside a tmux session named for the folder. Everything after `--` goes to omp, for example `omp-app tui -- --resume <chat id>`. It takes no `--port`, `--no-open` or `--lines`. It needs a real terminal (over SSH, use `ssh -t`) and tmux, and it says so when either is missing. Run again in the same folder, it goes back to the session; inside tmux it switches to the session instead of nesting one. See [Using the app](using.md#omp-in-the-terminal-on-the-same-chats). |
| `omp-app pair` | Prints a one-time code for a new device, with its QR code. The code works once, for 10 minutes; running the command again makes a new code, and the old one stops working. It needs the app to be running, and it takes no folder or options. See [Other devices](devices.md#how-do-i-pair-a-device). |
| `omp-app devices` | Lists the paired devices: the start of each id, its name, its kind (Home Screen app, desktop window or browser) and when it last connected, and how many devices are asking to pair. It needs the app to be running. |
| `omp-app devices remove <device>` | Removes a paired device, named by its id, the first characters of its id (at least 4), or its name in any letter case. The device's key stops working and its open windows close. It says so when no device or several devices match. |
| `omp-app logs [--lines <n>]` | Prints where the app's log is and its last lines, oldest first, from the current and the previous log file. `--lines <n>` (or `--lines=<n>`) sets how many; the default is 100. `n` is a whole number above 0. |
| `omp-app debug-report` | Writes `omp-app-debug-<time>.log` in the current folder (readable by your account only): the app and omp versions, the last 2,000 log lines and the omp processes of the running server. It is meant to be attached to an issue. **Save debug log** in the app (the palette, or Settings → App) downloads the same report. See [Troubleshooting](troubleshooting.md#how-do-i-save-the-debug-log). |

## What does the `omp-app-desktop` command take?

The window reads these options when it starts:

| Option | What it does |
|---|---|
| `--remote <address>`, `--remote=<address>` | Keeps the address of the app's server on another computer, and opens that server in the window now and at every later start, starting nothing on this computer. The address must be an `https://` address, normally `https://<computer>.<tailnet>.ts.net/`. It stops with "omp app: --remote needs the server's address" when there is none, and with "omp app: the address must look like https://<computer>.<tailnet>.ts.net/" for any other shape; the exit code is 2. See [Other devices](devices.md#how-do-i-open-another-computers-server-in-the-desktop-window). |
| `--local` | Forgets the kept address: the window opens this computer's own server again. When both options are given, the last one counts. |
| `--new-window` | Opens another window in the app that is already open. The applications-menu entry's "New Window" action runs it. |
| `omp-app://chat/<chat id>?server=<origin>`, `omp-app://open?server=<origin>` | A link, as the system passes it: the package registers the app for `omp-app:` links. The window on that server comes forward and shows the chat; with no window on it, a new window opens on it at the chat. Only a server the app already opens counts (this computer's, or one on another computer it opened before): a link to any other opens nothing, and the app logs "omp app: a link named a server this app has not opened, so nothing opened". The lite view's **Open in the desktop app** opens these links ([Integrations](integrations.md)). |

When the app is already open, a second launch with `--remote` or `--local` moves its first window to that server; a second launch with a link shows its chat; a second launch with nothing brings forward the window that had the focus last.

The server the window starts runs with the window's own environment, plus `OMP_APP_PORT=4317`. It asks for the same port as the `omp-app` command and the user service, so the web app keeps its stored settings (theme, sidebar, last chat) whichever of them started the server, and it takes a free port when 4317 is busy. When a server is already running, the window attaches to it and starts nothing, so with the user service running, the service's variables are the ones that apply.

## Environment variables

These are the variables you may set. Each is read by the server when it starts, so a change needs a restart of the server (see [Installing](install.md#how-do-i-update-it) for how). None of them is needed for a normal install.

| Variable | Meaning | Default |
|---|---|---|
| `OMP_APP_PORT` | The port the server listens on, on 127.0.0.1. `--port` wins over it. A value that is not a whole number is ignored. | `4317`, or a free port when that is busy |
| `OMP_APP_DATA_DIR` | The folder for the app's own data (see [below](#where-does-the-app-keep-its-data)). Give an absolute path. Moving it starts the app with no paired devices and no drafts. | The `app` folder inside omp's agent folder: `~/.omp/agent/app` |
| `OMP_APP_REMOTE_ORIGIN` | The one address other devices open the app at: your computer's Tailscale name served over HTTPS by `tailscale serve`, as `https://<computer>.<tailnet>.ts.net`. It must be `https`, end in `.ts.net`, and have no port, path, query or fragment. A value that is not that stops the app from starting, with the reason. The server still listens on 127.0.0.1 only. See [Other devices](devices.md). | Unset: no other address |
| `OMP_APP_FRAME_ANCESTORS` | The pages that may show the app's `/lite` view in a frame, such as another app's side panel, separated by spaces, on top of those named in **Settings → App → Integrations** ([Integrations](integrations.md)). Each is a Tailscale address over HTTPS (`https://<name>.ts.net`, a port allowed), a loopback address with its port (`http://127.0.0.1:<port>` or `http://localhost:<port>`), a kind of extension (`moz-extension:`, `chrome-extension:`) or one extension's address, or VS Code's panels (`vscode-webview:`, `vscode-file:`). Any other value stops the app from starting. | Unset: only the pages named in Settings may frame the app |
| `OMP_APP_CHROME` | The Chrome or Chromium program the Browser panel runs as the app's own browser. | The first of `google-chrome`, `google-chrome-stable`, `chromium` and `chromium-browser` found on the path |
| `OMP_APP_BROWSER_PORT` | The DevTools port of the app's own browser, on 127.0.0.1. omp attaches to it. `0` lets Chrome choose one. | `9333` |
| `OMP_APP_BROWSER_NO_SANDBOX` | `1` runs the app's browser without Chrome's sandbox. Use it only where the sandbox cannot start, such as a container without user namespaces: it weakens Chrome against a hostile page. | Off (Chrome's sandbox is on) |
| `OMP_APP_SHARE_ADDRESS` | The address of this computer that shared ports and pages open at. Give an address of this computer on a private network, such as your tailnet. Only paired devices get past a share's sign-in. | This computer's Tailscale IPv4 address; with none, nothing can be shared |
| `OMP_APP_DETACHED_HOSTS` | `1` runs each chat in a host process that outlives the server, so restarting the server stops no chat. See [Installing](install.md#how-do-i-update-it). | Off: a chat ends with the server |
| `OMP_APP_NEW_CHATS_READY` | `1` keeps a new chat started and waiting in each of the last two folders new chats were opened in, so "New chat" opens at once. A waiting chat is replaced about every 9 minutes and costs one more omp process per folder. The installed `omp-app` command and the window always do this, so the variable changes nothing there; it matters only to a server started from a source checkout. | Off |
| `OMP_APP_HANDBACK_MS` | With `OMP_APP_DETACHED_HOSTS=1`: how many milliseconds a chat host waits for a server to come back before it hands its chat back (a running turn is finished first). A value that is not a number above 0 is ignored. | `120000` (two minutes) |

More variables that the app reads, and that are not its own:

| Variable | Meaning |
|---|---|
| `XDG_STATE_HOME` | Moves the state folder. Used only when it is an absolute path. |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME` | Move the window's config and web data folders. Used only when absolute. |
| `XDG_RUNTIME_DIR` | Where the sockets of detached chat hosts go (`omp-app-hosts-<id>`); the temporary folder when it is not set. |
| `PI_CODING_AGENT_DIR` | omp's own variable for its agent folder. The app passes it to every chat, and puts its data folder under it unless `OMP_APP_DATA_DIR` says otherwise. The default is `~/.omp/agent`. |

### How do I set variables for the user service?

The service has its own environment, separate from your shell. Open an override file for it:

```bash
systemctl --user edit omp-app
```

In the editor that opens, add the variables under `[Service]`:

```ini
[Service]
Environment=OMP_APP_REMOTE_ORIGIN=https://<computer>.<tailnet>.ts.net
Environment="OMP_APP_FRAME_ANCESTORS=https://<name>.ts.net http://127.0.0.1:<port>"
```

Put quotes around a whole `NAME=value` when the value holds a space, and give absolute paths: systemd does not expand `~` here. Save, then restart the service so the server reads them:

```bash
systemctl --user restart omp-app
```

Undo: run `systemctl --user edit omp-app` again and delete the lines, or run `systemctl --user revert omp-app` to remove every override. Then restart the service again. For a server you start by hand with `omp-app`, set the variable in that terminal first, for example `OMP_APP_PORT=4400 omp-app`; if a server is already running, `omp-app` only attaches to it and the variable has no effect.

## Where does the app keep its data?

### The state folder

`~/.local/state/omp-app`, or `$XDG_STATE_HOME/omp-app` when that variable is an absolute path. Only your account can enter it.

| File | What it is |
|---|---|
| `omp-app.log`, `omp-app.log.1` | The app's log, and the part before it. Together they never pass 15 MiB. It records the versions and folders, omp's start and checks, every omp process, every browser connection (opened, closed with its code, turned away), every failed call, crashes, the page's errors, the page's measurements (such as how a lost connection came back), and every 30 seconds the server's memory and how long it was blocked at worst. It never holds your prompts, file contents, the access token in the launch link, or API keys, and each line is scrubbed for key and token shapes before it is saved. File paths and error messages can still appear. |
| `launch-token` | The secret in the launch link (after `#token=`), 43 characters, readable by your account only. It stays the same from one start to the next, so a saved link keeps working. Delete it and restart the app to get a new link; the old link then says it has expired. |
| `instance.json` | The record of the running server: its process id, its link (with the token) and its version. The command, the window and `omp-app pair` read it to find the running app. It is removed when the server stops, and readable by your account only. |

### The app data folder

`~/.omp/agent/app`, or the folder `OMP_APP_DATA_DIR` names. It holds:

| Path | What it is |
|---|---|
| `drafts/` | What you typed in message boxes, saved continuously. |
| `attachments/` | Pictures and files attached to drafts. Ones no draft refers to are removed after a day. |
| `devices.json` | The paired devices: each one's name, kind and times, and a hash of its key, never the key. |
| `embedders.json` | The pages and panels named in **Settings → App → Integrations** that may show the app in a frame. Readable by your account only. |
| `host-folders/` | One empty folder for each project whose files are on another computer, made when a panel there (the VS Code extension) opens it: `host-folders/<host>/<project>-<id>`, readable by your account only. That project's chats run there, without omp's tools for this computer's files and shell. ([Integrations](integrations.md)) |
| `model-preferences.json` | The models you starred and hid. |
| `checkpoints/`, `plans/`, `background-job-stops/` | Per-chat records of checkpoints, plan documents and background jobs you stopped. |
| `workspace-files/` | What the Files panel keeps: uploads in progress, and deleted files that can still be undone. |
| `usage-readings.json`, `usage-resume.json`, `usage-pause.json` | The usage numbers behind the dashboard's pace, and the chats the app will continue or has paused at a usage limit. |
| `todos.json` | The dashboard's to-do list, with its last 200 changes for Undo. A file the app cannot read is moved aside as `todos.unreadable-<time>.json`, and the list starts empty. |
| `questions.json` | Every chat's questions that wait for an answer, for the dashboard; the chats keep their own questions in their session files. |
| `siyuan-copy.json` | Where the to-do list's copy in SiYuan goes, with SiYuan's API token: readable by your account only. Deleted when the copy is turned off. |
| `session-summaries.json`, `session-subagents.json`, `omp-probe-cache.json` | Caches of chat titles, subagents and what omp reported at its last start. |
| `launch-links.json` | Digests (not the tokens) of earlier launch tokens, so an old link can say it has expired. |
| `browser-edge.json` | Whether "Your own browser" is chosen in the Browser panel. |
| `server-browser/profile/` | The profile of the app's own browser, with the sign-ins and cookies you made in it. |
| `omp-app-usage-reset-policy.yml` | A small omp settings file the app adds to every chat it runs (see below). |

Chats themselves are not here. omp keeps them in its own session files under `~/.omp/agent/sessions`, and the app keeps no copy of them, only the caches above.

### The desktop window's files

| Path | What it is |
|---|---|
| `~/.config/omp-app/desktop-server` | The address kept by `omp-app-desktop --remote`, readable by your account only. `--local` deletes it. Under `$XDG_CONFIG_HOME` when that is an absolute path. |
| `~/.config/omp-app/desktop-servers` | The servers on other computers the window opened, up to 8, for the palette and Settings. |
| `~/.local/share/omp-app/desktop-window` | The window's own web data: the pairing key (a cookie) and the pages' settings. Under `$XDG_DATA_HOME` when that is an absolute path. |

A file the window saves ("Download" in the Files panel, or **Save debug log**, for example) goes to your Downloads folder: the one named in `~/.config/user-dirs.dirs`, or `~/Downloads` when that is missing. It does not go to the folder the window was started from.

## Which omp settings does the app read or change?

The app does not keep a copy of omp's settings. Settings → the omp tabs read and write omp's own files:

- **Every folder:** `config.yml` in omp's agent folder (`~/.omp/agent/config.yml`; `config.yaml` is read as a fallback).
- **This folder:** `.omp/config.yml` inside the folder.

The switch at the top of Settings, "Every folder" or "This folder", chooses which file a change goes to. Model roles, fallbacks, presets and compaction limits set in the app's Models panel are omp's own settings too, so omp's terminal uses them. A setting that an environment variable overrides says so ("$NAME sets it while that variable is set") and cannot be edited while the variable is set; omp's `PI_BROWSER_RELAY`, for one, overrides `browser.relay`.

Two settings are changed by the app itself, in the global file, when you choose a browser in the Browser panel:

| Setting | What the app does with it |
|---|---|
| `browser.relay` | Set to `true` when you choose "Your own browser", and removed when you choose another browser. A `browser.relay` you set by hand counts as that choice and stays until you choose another browser in the panel. |
| `browser.cdpUrl` | Set to the address of the app's own browser (`http://127.0.0.1:<port>`, the DevTools port) when you choose "The one shown here", and removed when chats stop using it. |

Choosing "omp's hidden one" leaves both unset. The relay for your own browser listens on port 9224 of 127.0.0.1.

The app also adds one settings file of its own to every chat it runs, through omp's `PI_CONFIG_FILES`: `omp-app-usage-reset-policy.yml` in the data folder, which turns off `codexResets.autoRedeem` and `claudeResets.autoRedeem`, so that a chat does not silently spend your saved provider resets. Chats you open with `omp-app tui` do not get it.
