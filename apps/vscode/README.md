# apps/vscode

omp app's VS Code extension: omp app's chat in VS Code's secondary side bar, on the right beside its other chat panels, for the folder open in VS Code (in a workspace of several folders, the first). omp app's server may be another computer: the chat runs there, and reaches the folder through the extension's tools, on the computer VS Code runs on. It needs VS Code 1.106 or newer, the first that lets an extension place a panel there.

- **The panel** (`src/panel.ts`, its page `src/webview.ts`): a view in the secondary side bar (Ctrl+Alt+B shows and hides that side bar; its **omp app** tab shows the chat), and **omp app: Open in an editor tab** for a chat in a tab. It shows the lite view with `@omp-app/embed`, pairs once (the extension keeps the key in VS Code's secret storage, as `docs/integrations.md` says), reopens the side bar's chat for this folder, and sends the open file's path and your selection with each message (setting `ompApp.sendOpenFile`).
- **The folder's chats.** The panel tells omp app which folder is open (`files`: its name, and 16 hex digits of the SHA-256 of its path). Its chats run in that folder's own empty folder on the server (`host-folders/vscode/<name>-<id>` in omp app's data), without omp's tools for the server's files and shell, so each folder has its own chats and nothing in them works on the server's files.
- **The tools** (`src/tools.ts`, run in `src/workspace.ts`): `vscode_read`, `vscode_list`, `vscode_search`, `vscode_edit`, `vscode_write`, `vscode_run`, `vscode_problems`, `vscode_open`. Each works inside the open folder only, also after links are followed. Reading takes what an editor shows, unsaved changes too; listing and searching leave out what VS Code's own search leaves out.
- **Changes and commands are yours to allow.** Each change to a file opens as VS Code's diff, with ✓ Accept and ✗ Reject in its title bar and in a notification (`src/review.ts`). An accepted change to an existing file is made through VS Code, so its Undo takes it back, and saved; a new file is written. Each command asks first, in a dialog showing the command, and its output also goes to the **omp app** output channel. Settings `ompApp.reviewEdits` and `ompApp.askBeforeCommands` turn either off.

## Build and try

```sh
bun install
bun run --cwd apps/vscode build [version]
cp LICENSE apps/vscode/
(cd apps/vscode && npx @vscode/vsce@4.1.0 package --no-dependencies)
```

writes `apps/vscode/omp-app-vscode-<version>.vsix`. **Each release** attaches it as `omp-app-vscode_<version>.vsix`. In VS Code: Extensions → `⋯` → **Install from VSIX…**, or `code --install-extension omp-app-vscode_<version>.vsix`. Then:

1. In omp app, turn on **Settings → App → Integrations → VS Code**, so a VS Code panel may show the app.
2. In VS Code, set **omp app: Address** (`ompApp.address`) to omp app's address, as you open it in a browser: an `https://` address, or `http://127.0.0.1:<port>` when the app runs on this computer (the panel's **Set the address** button opens the setting). The panel shows the app at once. When the app's page has not opened in it after 10 seconds, the extension asks the app why (it cannot be reached, it is not the app, or it does not let VS Code show it yet) and says so over the panel, with **Try again**; the page keeps loading under the note, and the chat replaces the note as soon as it answers. The extension may reach the network another way than the panel (a remote window's computer), so it never keeps a page from showing.

   **Behind a proxy.** VS Code sends the panel's connections, and the extension's, through the proxy in its `http.proxy` setting, else one named in the environment it was started with (`https_proxy`, `http_proxy`), whatever the system's proxy settings say; a browser on the same computer may connect directly. A proxy often can't reach an address on your own network, such as a Tailscale name, which only this computer's resolver knows: the connection is reset, and the panel then names the proxy and offers **Connect without the proxy**, which adds the app's host name to VS Code's `http.noProxy` setting, so VS Code connects to it directly and the panel opens. To undo it, remove that entry from **Settings → http.noProxy**.
3. Show the secondary side bar (Ctrl+Alt+B), open its **omp app** tab, and pair: allow the panel in omp app, or type a one-time code from **Settings → App → Devices**. **omp app: Forget this computer's key** makes it pair again.

**What it sends where.** The open file's path and your selection, and what its tools read and what commands print, go to the omp app at the address you set, and nowhere else.

## Checks

- `bun run --cwd apps/vscode test`: which paths a call may name, edits, reads, searches and long output; why the app would not show; which addresses go through VS Code's proxy.
- `bun run --cwd apps/vscode test:vscode`: the tools and the change review inside real VS Code, and the side bar's panel framing a stand-in for omp app (the frame rule, the `hello`, the key kept, a tool's call). It downloads VS Code once into `VSCODE_TEST_CACHE` (default `.vscode-test/`) and runs it with no display.
- `apps/web/e2e/v2-vscode-panel.spec.ts`: the panel's page against the real app in Chromium, with a stand-in for VS Code: pairing, the folder's chat without omp's file tools, a tool's call, the open file.
- `apps/web/e2e/v2-vscode-real.spec.ts`: the extension packed with `vsce` as the release packs it, installed into a real VS Code (`OMP_APP_VSCODE`, as the build server's test image has it) and opened in the secondary side bar: it says the app does not let VS Code show it yet, shows it after Integrations' switch and **Try again**, pairs with a one-time code, reads a file, changes it after **Accept**, and runs a command after **Run**.
