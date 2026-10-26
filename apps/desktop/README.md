# omp app desktop

A desktop window for the omp app. It opens the app in a window on the app's own server: on the one that already runs, or, when none runs, on one it starts itself (inside the package, nothing else to install). The window opens at once on a starting page, and shows the app when the server answers. A second launch brings the open window forward.

Closing the window leaves the server running, so chats keep going; stop it with `systemctl --user stop omp-app` when the user service runs it, else `kill $(jq .pid ~/.local/state/omp-app/instance.json)`.

The server the window starts uses port 4317, the port of the `omp-app` command and the user service, when it is free, so the web app keeps its stored settings (theme, sidebar, last chat) whichever of them started the server. When the port is busy, the server takes a free port instead.
"Save debug log" (in the command palette) saves its file into your Downloads folder: the one set in `~/.config/user-dirs.dirs`, or `~/Downloads` when that setting is missing (the folder is created if it does not exist). It does not save into the folder the window was started from.

The window bundles the omp coding agent: every chat runs omp's own command line, which the app builds from the omp package it pins and the package holds compiled (`/usr/lib/omp-app-desktop/chat-host`), and omp's own commands run the omp release the app pins (named in `packages/server/src/omp-pin/pin.json`), never an omp installed on this computer. There is nothing to install.

The package is `omp-app-desktop` and its menu entry is "omp app". It does not replace or touch the `omp-app` command package.

## Prerequisites (Ubuntu 24.04 or newer)

The window needs glibc 2.39, which Ubuntu 24.04 has. The package declares that dependency.

1. The Linux libraries that Tauri 2 needs:

   ```
   sudo apt-get update
   sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
   ```

2. Rust (stable), with rustfmt and clippy:

   ```
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal -c rustfmt -c clippy
   . "$HOME/.cargo/env"
   ```

3. Bun 1.3.14, the version `release.yml` uses, and Bun 1.4.3 for the chat host: the Bun omp's release is built with (`packages/server/scripts/build-chat-host.ts` names it and refuses another). Unpack Bun 1.4.3 anywhere, for example from `https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-linux-x64.zip`, and name it in `CHAT_HOST_BUN`.

## Build the package

From the repository root:

```
bun install --frozen-lockfile
CHAT_HOST_BUN=/path/to/bun-1.4.3/bun bash packaging/build-desktop-deb.sh 0.1.451
```

The package lands in `dist/desktop/omp-app-desktop_0.1.451_amd64.deb`, with `SHA256SUMS` next to it. The build downloads the omp release the app pins and checks it against the release's SHA-256 checksum, so it needs network access.

The Rust build needs four inputs that the build script creates and git ignores: the server (`src-tauri/binaries/`), the web app (`src-tauri/resources/web`), the chat host (`src-tauri/resources/chat-host`) and the pinned omp (`src-tauri/resources/omp`). So on a fresh checkout, run the build script once before the Rust checks:

```
cd apps/desktop/src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

## Install and remove

The window's package is `omp-app-desktop`. Each release lists it beside the terminal command's package (`omp-app`); the two do not depend on each other. To install the package built here:

```
sudo apt install ./dist/desktop/omp-app-desktop_<version>_amd64.deb
sudo apt remove omp-app-desktop
```

Removing the package removes its bundled omp too, and leaves the `omp-app` command package alone.

## Checks by hand

These two need a person at a real desktop: the automated runs use a virtual display, where the input method and the window manager differ (see #1124, which stays open until these are answered).

1. Open "omp app" from the applications menu. Click New chat, click the message box, press Ctrl+K, and type `deb`. Expected: `deb` appears in the "Search commands" box. Press Escape. Expected: the palette closes. Write down what you see for each.
2. In a terminal, run this line. Expected: the input-method and display settings of the window, one per line (for example `XMODIFIERS=...`). If nothing prints, open "omp app" first, then run it again.

   ```
   tr '\0' '\n' < /proc/$(pgrep -n omp-app-desktop)/environ | grep -E 'XMODIFIERS|GTK_IM|QT_IM|GDK_BACKEND'
   ```

3. Copy a picture (a screenshot, for example), click New chat, click the message box, and press Ctrl+V. Expected: a chip named `Pasted image 1.png` appears above the box. The automated runs use X11, so on GNOME's Wayland session this is the check that counts.
