# Releasing

How releases are made, how to build and check the packages yourself, and what an installed app does when a new version comes out. For installing a release, see the [README](../README.md). For the tests a release runs, see [testing.md](testing.md).

A release is two Debian packages of the same version and one checksum file:

| File | What it is |
|---|---|
| `omp-app_<version>_amd64.deb` | The terminal command, `omp-app`, with its user service |
| `omp-app-desktop_<version>_amd64.deb` | The "omp app" window with its bundled server |
| `SHA256SUMS` | The SHA-256 of both packages, in the format `sha256sum -c` reads |

Both packages hold their own chat host, built from the omp release the app pins, so neither depends on an omp installed on the computer.

## The release workflow

`.github/workflows/release.yml` builds and publishes the release.

**When it runs.** On a schedule, at 01:00 and 13:00 UTC every day, and by hand:

```bash
gh workflow run release.yml                  # the same checks as the schedule: builds only if the product changed
gh workflow run release.yml -f force=true    # builds even if nothing changed since the last release
```

It only ever builds `main`, never starts from a pull request, and has no credentials beyond a token that can write releases and tags (`contents: write`). Only one run goes at a time. It runs on GitHub's hosted Ubuntu 24.04 runner and gives up after 60 minutes. Only GitHub-owned actions are allowed in the repository, so Bun and Rust are installed by steps that download a pinned version and check it against a published checksum.

**Whether it builds.** The first step reads the version (below) and decides:

- if the release `v<version>` already exists, nothing is built;
- if there is no release yet, or `force` is set, it builds;
- otherwise it builds only when something in `apps/`, `packages/` or `packaging/`, or `bun.lock`, `package.json` or `tsconfig.base.json`, differs from the commit of the latest release. A change to the docs alone does not make a release.

**What it builds and checks**, in order:

1. Installs Bun 1.3.14 and, for the chat host, Bun 1.4.3, and runs `bun install --frozen-lockfile`.
2. Builds the terminal-command package with `packaging/build-deb.sh`, and smoke-tests it with `packaging/smoke-test.sh`.
3. Installs the libraries the window needs, Rust (stable) and a cache of Cargo's registry and build.
4. Builds the desktop package with `packaging/build-desktop-deb.sh`, and smoke-tests it under a virtual display with `packaging/desktop-smoke-test.sh`.
5. Copies the desktop package next to the other and adds its line to `SHA256SUMS`.
6. Writes the release notes, then publishes.

Nothing is published until every step before it has passed: when a smoke test fails, the run fails and the release does not exist. The last step creates the GitHub release `v<version>`, titled `omp app <version>`, with the two packages and `SHA256SUMS` attached, tagged on the commit that was built.

### The version scheme

The version is `0.3.<number of commits on main>` (`git rev-list --count HEAD`). It only goes up, and it names exactly one commit. The packaging scripts take any version of the form `X.Y.Z` as their argument.

### The release notes

`packaging/release-notes.sh <version> <last release tag, or empty> <notes file>` writes them. They hold an Install section with the command for each package, then the list of what changed: the subject line of every commit since the last release that touched `apps/`, `packages/` or `packaging/` (the latest 80), or the latest 40 such commits for the first release. The notes are the commit subjects as written, which is why [CONTRIBUTING.md](../CONTRIBUTING.md#commit-messages) asks for subjects a user can read.

## The desktop workflow

`.github/workflows/desktop.yml` checks the window without making a release. It runs on pull requests that change `apps/desktop/**`, `packaging/build-desktop-deb.sh` or `packaging/desktop-smoke-test.sh`, and by hand, with read-only permissions; a newer run on the same ref cancels an older one. It installs the Linux libraries Tauri 2 needs, Rust (stable with `rustfmt` and `clippy`) and the two Bun versions, then:

1. checks the Rust formatting (`cargo fmt --check`);
2. builds the desktop package, version `0.3.<commits>`;
3. runs `cargo clippy --all-targets -- -D warnings` and `cargo test` in `apps/desktop/src-tauri`;
4. smoke-tests the package under a virtual display;
5. uploads `dist/desktop/` (the package and the smoke test's screenshots) as the build artifact `omp-app-desktop`, kept 14 days.

## Building packages locally

You need a checkout with `bun install --frozen-lockfile` done, `dpkg-deb`, and Bun 1.4.3 for the chat host: set `CHAT_HOST_BUN` to its path (without it, the script uses the `bun` on the path, and refuses it unless it is 1.4.3).

**The terminal command:**

```bash
CHAT_HOST_BUN=/path/to/bun-1.4.3/bun bash packaging/build-deb.sh 0.3.1
```

It builds the UI (`bun run build`), compiles `packages/server/scripts/omp-app.ts` into one program with Bun's runtime and the version (`bun build --compile`), compiles the chat host (`packages/server/scripts/build-chat-host.ts`), and stages the package: `/usr/bin/omp-app`, `/usr/lib/omp-app/chat-host`, `/usr/share/omp-app/ui`, an applications-menu entry (`packaging/omp-app.desktop`), the icon, and the user service (`packaging/omp-app.service`, installed at `/usr/lib/systemd/user/omp-app.service`). Its post-install script enables the service for every user (`systemctl --global enable omp-app.service`) and its pre-removal script turns that off again on removal. The result is `dist/release/omp-app_<version>_amd64.deb` and `dist/release/SHA256SUMS`.

**The window:**

```bash
CHAT_HOST_BUN=/path/to/bun-1.4.3/bun bash packaging/build-desktop-deb.sh 0.3.1
```

It needs Rust and the Linux libraries listed in [apps/desktop/README.md](../apps/desktop/README.md). It builds the UI, puts the UI, the compiled server (as the sidecar `omp-app-desktop-server`) and the chat host into `apps/desktop/src-tauri` (`resources/` and `binaries/`, both git-ignored), and has Tauri build the package (`bun run tauri build --bundles deb`). It then checks the package's name, version and contents, that it shares no file with the terminal command's package (so both can be installed), and that its menu entry is named "omp app" with a New Window action. The result is `dist/desktop/omp-app-desktop_<version>_amd64.deb` and `dist/desktop/SHA256SUMS`. If you set `CARGO_TARGET_DIR`, it must be an absolute path.

## Checking a package

```bash
bash packaging/smoke-test.sh dist/release/omp-app_<version>_amd64.deb

xvfb-run -a -s "-screen 0 1280x800x24" dbus-run-session -- \
  bash packaging/desktop-smoke-test.sh dist/desktop/omp-app-desktop_<version>_amd64.deb
```

- `packaging/smoke-test.sh` unpacks the package into a temporary folder and runs the installed command there, with its own home, state, agent and data folders; nothing outside the temporary folder is touched. What it checks is listed in [testing.md](testing.md#the-desktop-checks).
- `packaging/desktop-smoke-test.sh` runs the window under a virtual display and a private session bus, and refuses to run when `WAYLAND_DISPLAY` is set or `DISPLAY` is not a virtual display. It needs `xvfb`, `xdotool`, ImageMagick, `dbus-x11`, Python 3, and `bun` on the path (one check runs the fake model). Its screenshots go into a `screenshots` folder beside the package.

## How an installed app gets an update

The code has no updater: nothing in the server, the window or the packages checks for a new release or installs one, and the repository publishes no package archive. An update is a new release's packages, installed over the old ones (`sudo apt install ./<file>.deb`). What the code does around that:

- **The service.** The package's post-install script enables the user service, and the build script's comments say an upgrade keeps it enabled. No script restarts a running server. A server that is running when the package is replaced goes on running the old build until it is stopped and started again: at the next login, or with `systemctl --user restart omp-app`.
- **Open pages.** A page asks the server whether it still serves the build the page is running: when its connection opens again (as after a restart), when the page is shown or focused, and every 10 minutes (`apps/ui/src/update.ts`). When the served page names another build, a banner says "The app was updated. Reload to use the new version." with a **Reload** button (`apps/ui/src/ConnectionBanner.tsx`).
- **The window.** It attaches to a server that is already running instead of starting its own, so what it shows is the running server's version ([apps/desktop/README.md](../apps/desktop/README.md)).
- **Which version is running.** `omp-app --version` prints the installed command's version, the `start` line of the debug log names the server's, and `omp-app` run while the app is already running prints the running server's.
