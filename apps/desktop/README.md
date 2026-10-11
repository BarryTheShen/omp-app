# omp app desktop

A desktop window for the omp app. It finds the omp coding agent, starts the app's own server (inside the package, nothing else to install) on this computer, and opens the app in a window. The window opens at once on a starting page, and shows the app when the server answers. When the window closes, it hides at once; then the server and every omp process it started are stopped, and the app ends (this can take a few seconds while omp is busy). A second launch brings the open window forward.

The server uses port 27183 when that port is free, so the web app keeps its stored settings (theme, sidebar, last chat) from one launch to the next. When the port is busy, the server takes a free port instead.

omp must already be installed. The window looks for it on the PATH of your session, in `~/.bun/bin`, `~/.local/bin`, `/usr/local/bin` and `/usr/bin`, and then in your login shell (a window started from the applications menu does not get your shell's PATH). If it finds none, it shows a page that says omp is not installed and where to get it.

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

3. Bun 1.3.14, the version `release.yml` uses.

## Build the package

From the repository root:

```
bun install --frozen-lockfile
bash packaging/build-desktop-deb.sh 0.1.451
```

The package lands in `dist/desktop/omp-app-desktop_0.1.451_amd64.deb`, with `SHA256SUMS` next to it.

The Rust build needs two inputs that the build script creates and git ignores: the server (`src-tauri/binaries/`) and the web app (`src-tauri/resources/web`). So on a fresh checkout, run the build script once before the Rust checks:

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

Removing the package leaves the `omp-app` command package and omp itself alone.

## Limits

- If the window process is killed outright (for example with `kill -9`), the kernel tells the server to stop, and the server ends the omp processes it started. A command that omp runs in its own session can keep running after that, because the stop does not reach it.
- If the window is killed while the login-shell lookup is still running (at most five seconds at start-up), a start-up file that is still running keeps its processes. Closing the window, or quitting, ends them.
