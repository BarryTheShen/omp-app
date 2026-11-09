# Troubleshooting

Each section below starts from something the app shows or prints, in its own words, and says what it means and what to do. The last section is about the debug log, which is what to attach when you ask for help.

## omp cannot start, or has no model

**What you see.** In the terminal where `omp-app` runs (or in `journalctl --user -u omp-app` when the user service runs it), after the link:

```text
Warning: omp could not start. The app opens, but chats cannot start. Run `omp-app debug-report` and attach the file to an issue.
```

The first sentence is the app's reason. It is one of "omp was not found.", "omp could not start.", "omp did not answer in time.", "omp started but did not answer the app's checks.", "omp started but did not answer the app's checks in time." and "omp has no model to chat with, so no chat can start."

In a chat that cannot open, the page says "Could not open this chat:" and one of these:

- "no model is set up yet. Open a terminal, run “omp-app tui”, and choose a model with /model or sign in with /login there, then start a new chat."
- "omp cannot sign in to its model. Open a terminal, run “omp-app tui”, and sign in with /login there, then start a new chat."
- "omp stopped as it started. Open a terminal and run “omp-app tui” to see why, then start a new chat."

**Why.** Every chat runs on the omp the package holds, started without its terminal. omp stops when no model is set up or when it cannot sign in to the model's provider. omp's terminal app starts anyway and offers `/model` and `/login`. Any other reason, such as a damaged install or a computer that is too busy to start omp in time, appears in the app's log.

**What to do.**

1. Run `omp-app tui` in a terminal. In omp, choose a model with `/model`, or sign in with `/login`. Then start a new chat in the app.
2. If the reason is anything else, run `omp-app debug-report`; it records omp's start and checks.
3. If `omp-app` says "the app's chat host is missing", with a path, the package's own file is gone: reinstall the package ([Installing](install.md#how-do-i-install-it)). The same goes for "the app's web files were not found. Reinstall the package, or run `bun run build` in a source checkout."

## The app does not start and names a variable

**What you see.** `omp-app` stops at once with a line that begins `omp-app:` and names `OMP_APP_REMOTE_ORIGIN` or `OMP_APP_FRAME_ANCESTORS`, for example "OMP_APP_REMOTE_ORIGIN must be the HTTPS address the app is served at, like https://omp.example.com (a port allowed), with nothing after it, not "<what you set>"."

**Why.** The app accepts only an HTTPS address for the first, and for the second only HTTPS addresses, loopback addresses with a port, and extension or editor panels, separated by spaces. A wrong value stops the start, so that the app never listens for an address it cannot check.

**What to do.** Correct the value (see [Other devices](devices.md#how-do-i-open-the-app-from-other-devices) and [Configuration](configuration.md#environment-variables)) or remove it, then start the app again. Under the user service, the message is in `journalctl --user -u omp-app`; fix the value with `systemctl --user edit omp-app`, then run `systemctl --user restart omp-app`.

## A link is refused

**What you see.** A banner under the status bar, and the connection line at the foot of the chat list says "Disconnected". The banner says one of:

| Banner | Why | What to do |
|---|---|---|
| "This link has expired. Open the app with the link omp-app printed when it last started." | The link's secret is an earlier one: the app's launch token was replaced since the link was made, for example because its file was deleted. | Open the app with the current link. `omp-app --no-open` prints it. |
| "This link is not valid. Open the app with the link omp-app printed." | The link's secret is not one this app ever had, for example a link that was cut short or copied from another computer. | Use the link `omp-app` prints. |
| "This device is not paired with the app. Reload the page to pair it." | The page came without a paired device's key: it is not paired yet, it was removed from the list, or it used the launch link at the address other devices open, where only a paired device is let in. | Reload the page. It shows **Pair this device**; pair it as described in [Other devices](devices.md#how-do-i-pair-a-device). |
| "The app does not accept connections from this page's address." | The page was opened at an address the app does not take. It accepts `http://127.0.0.1:<port>`, `http://localhost:<port>` and the exact address in `OMP_APP_REMOTE_ORIGIN`. | Open the app at one of those. Check that `OMP_APP_REMOTE_ORIGIN` matches the address in your browser letter for letter, and that the port in the address is the port the app is on. |

The pairing page may add "The link this page was opened with no longer works." above its own explanation. Refused pages do not retry, because nothing would change: fix the cause, then reload.

## "Reconnecting to the app…"

**What you see.** A banner, "Reconnecting to the app…", with **Reconnect now**. The connection line at the foot of the chat list says "Reconnecting…". The banner appears when the link to the server has been down for 2 seconds, and 6 seconds after a page comes back to the front (a phone back from another app, a laptop awake again), so a short blip shows only the dot. If the link closes without a reason, the banner says "The connection to the app has closed." with **Reload**.

**Why.** The page lost its link to the app's server. The server may be stopped or restarting (an update, a reboot), the computer that runs it may be asleep or off, or the network between you and it, or what serves the app's address (Tailscale Serve, a proxy, a tunnel), is down.

**What to do.**

- Wait: the page reconnects by itself and resumes its streams where they left off. A link can die without closing, after a phone sleeps for example. The page asks the server every 30 seconds, and at once when you come back to it; when no answer comes, it drops the link and opens a new one.
- Press **Reconnect now**, or click the connection line, to try at once.
- Check that the server runs, on the computer that hosts it: `systemctl --user status omp-app`, and `omp-app logs`. If another device cannot reach it, see [Other devices](devices.md#how-do-i-open-the-app-from-other-devices).
- What you typed is not lost. Drafts are saved continuously, and a send that fails keeps its text in the box.

## "The app was updated. Reload to use the new version."

**What you see.** A banner with a **Reload** button.

**Why.** The page you have open was loaded before the app was updated, and the server now serves a different build of the web app. A page runs the build it loaded until it reloads. The page checks when its connection opens again, when you come back to it, and every 10 minutes.

**What to do.** Press **Reload**: the page reloads and shows the same chat again.

## A part of the app says the server needs an update

**What you see.** One of these, in the part named:

- Settings → App → Devices: "This app server cannot pair devices yet; it needs an update."
- The Browser panel: "This server has no browser yet: it needs the app's next update."
- The Ports panel: "This server can't share pages yet: it needs the app's next update."
- The dashboard: "Rules come with the next server update.", and the same for the pace, the queue and the activity.

**Why.** The page is newer than the server it is talking to. Installing a new package replaces the app's files, but a server that was already running keeps running the old release until it restarts, and it serves the new web app.

**What to do.** Restart the server so the server and the page are the same release: [How do I update it?](install.md#how-do-i-update-it). Then reload the page.

## "This chat is open in another omp"

**What you see.** When you open a chat: "Could not open this chat: This chat is open in another omp, for example in a terminal. Close it there, then open it here."

**Why.** omp lets one omp write a chat at a time, and another omp, usually the one in a terminal, holds this chat.

**What to do.** Quit omp where the chat is open (`/exit`), or end its tmux session (`omp-app tui` names it for the folder), then open the chat again. The other way round, omp in the terminal opens a chat the app has open on a copy, which both then list as a chat of its own.

A related message, "This chat is finishing a reply it started before the app was updated. It opens here once that reply is done.", appears only when chats run in hosts that outlive the server (see [Configuration](configuration.md#environment-variables)). Wait for the reply to end; the chat then opens.

## `omp-app tui` does not start

- "the tui command opens omp in this terminal, and this is not one. Run it in a terminal (over SSH: ssh -t)." You ran it where no terminal is attached. Run it in a terminal, or add `-t` to your `ssh` command.
- "the tui command runs omp in tmux, which is not installed. Install it (on Ubuntu: sudo apt install tmux), then run this again."
- "The tui command takes a folder, then omp's own options after --." You gave it `--port`, `--no-open` or `--lines`, which it does not take. Put omp's own options after `--`.

## The Browser panel finds no Chrome

**What you see.** In the Browser panel, "No Chrome or Chromium was found on the server's machine." The choice "The one shown here" is greyed out.

**Why.** The app's own browser is a Chrome or Chromium on the computer that runs the server. The app looks for `google-chrome`, `google-chrome-stable`, `chromium` and `chromium-browser` on the path, or the program that `OMP_APP_CHROME` names. It found none. The computer that matters is the server's, not the phone or laptop you are looking at.

**What to do.** Install Google Chrome or Chromium on the server's computer, or set `OMP_APP_CHROME` to the program's path (for the user service, see [Configuration](configuration.md#how-do-i-set-variables-for-the-user-service)), then restart the server. The other two choices need no Chrome here.

Two more messages come from the same part:

- "The app's browser did not start." followed by the last line Chrome printed: press **Start the browser** again after fixing what that line says. Where Chrome's sandbox cannot start, such as a container without user namespaces, `OMP_APP_BROWSER_NO_SANDBOX=1` runs Chrome without it, which weakens Chrome against a hostile page. If another program holds Chrome's debugging port (9333), set `OMP_APP_BROWSER_PORT` to another port.
- "No relay could listen on port 9224: another program holds it." The relay for "Your own browser" could not start. Stop the program that holds the port.

## A port is already in use

**What you see.** When you start `omp-app`:

- "Port 4317 is in use; using a free one." The default port, or the one `OMP_APP_PORT` names, is held by another program. The app starts on a free port, and the link it prints has that port.
- "port N is in use. Pick another with --port." You gave `--port`, and that port is held. The app does not start.
- "port N was taken while omp app was starting. Start it again." Another start took the port in the moment between the check and the start.

**Why.** Something else listens on the port. Usually it is the app itself, already running, in which case `omp-app` does not start a second one: it prints "omp app <version> is already running." and its link.

**What to do.** Stop the program that holds the port, or choose another with `--port` or `OMP_APP_PORT`. A page keeps its settings (theme, sidebar, last chat) per address, so on a new port they start afresh; keep one port to keep them. For other devices, serve the port the app really uses (see [Other devices](devices.md#how-do-i-open-the-app-from-other-devices)).

## The window says "omp app could not start"

**What you see.** The desktop window shows "omp app could not start": "The app's server did not start, or it stopped on its own. Close this window and open omp app again."

**Why.** The window starts the server for you when none runs, and the server did not start or it ended while the window was open. While it starts, the window says "Starting omp app", which can take a few seconds, and up to a minute the first time.

**What to do.** Close the window and open "omp app" again. If it keeps happening, the log says what went wrong: `omp-app logs` prints it, and it is in `~/.local/state/omp-app/omp-app.log`.

The window can also say "omp app could not reach" a computer, or "omp app did not open on" one. That means it is set to open a server on another computer; see [Other devices](devices.md#how-do-i-open-another-computers-server-in-the-desktop-window) to check that computer or to go back with `omp-app-desktop --local`.

## Pairing does not work

- "The request was turned down." Someone pressed **Deny** on a paired device. Press **Ask again**.
- "The request ended after 5 minutes." No paired device allowed it in time. Press **Ask again**.
- "That code is not right: N tries left." Check the code against the one shown. Five wrong entries end the code.
- "That code no longer works. Make a new one in Settings → App → Devices on a paired device, or with `omp-app pair` on the app's computer." A code works once, for 10 minutes, and a newer code replaces it.
- `omp-app pair` or `omp-app devices` says "the app is not running, and only the running app can pair or list devices. Start it first (systemctl --user start omp-app when it runs as the service, or omp-app)." Start the app first.
- `omp-app devices remove <device>` says `no paired device is named "<device>". omp-app devices lists them.`, or `several paired devices match "<device>": give more of the id.` Use the id or name that `omp-app devices` lists.

## How do I save the debug log?

The app writes a log of what it does to `omp-app.log` in its state folder, `~/.local/state/omp-app` (or under `$XDG_STATE_HOME` when that is an absolute path). The part before it is in `omp-app.log.1`, and together they never pass 15 MiB. It records the versions and folders, omp's start and checks, every omp process, every browser connection (opened, closed with its code, turned away), every failed call, crashes, the page's errors (uncaught errors, unhandled promise rejections and console errors, at most 30 a minute), the page's measurements (such as how a lost connection came back), and every 30 seconds the server's memory and how long it was blocked at worst.

It never holds your prompts, file contents, the access token in the launch link, or API keys, and every line is scrubbed for key and token shapes before it is saved. File paths and error messages can still appear, so look at a report before posting it.

In the app, **Save debug log** downloads the report described below: it is in the palette (Ctrl+K, then type "debug") and in Settings → App → Debug log, which is where a phone finds it. The desktop window saves it in your Downloads folder.

From a terminal, two commands read it:

```bash
omp-app logs                  # where the log is, and its last 100 lines (--lines 500 for more)
omp-app debug-report          # writes omp-app-debug-<time>.log in this folder
```

`omp-app debug-report` writes one file, readable by your account only: the app's version, the system, the omp version and where it is, the last 2,000 log lines, and the omp processes of the running server. Attach that file to an issue (issues are open to collaborators only; see the [README](../README.md#project-status)).

When the user service runs the app, what it printed to its output, including the warning at the top of this page, is in `journalctl --user -u omp-app`.
