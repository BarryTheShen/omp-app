# apps/vscode

omp app's VS Code extension: omp app's chat in VS Code's side bar, for the folder open in VS Code (in a workspace of several folders, the first). omp app's server may be another computer: the chat runs there, and reaches the folder through the extension's tools, on the computer VS Code runs on.

- **The panel** (`src/panel.ts`, its page `src/webview.ts`): a view in the side bar (the chat bubble), and **omp app: Open in an editor tab** for a chat in a tab. It shows the lite view with `@omp-app/embed`, pairs once (the extension keeps the key in VS Code's secret storage, as `docs/integrations.md` says), reopens the side bar's chat for this folder, and sends the open file's path and your selection with each message (setting `ompApp.sendOpenFile`).
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
2. In VS Code, set **omp app: Address** (`ompApp.address`) to omp app's tailnet address, as you open it in a browser (the panel's **Set the address** button opens the setting).
3. Open the chat bubble in the side bar, and pair: allow the panel in omp app, or type a one-time code from **Settings → App → Devices**. **omp app: Forget this computer's key** makes it pair again.

**What it sends where.** The open file's path and your selection, and what its tools read and what commands print, go to the omp app at the address you set, and nowhere else.

## Checks

- `bun run --cwd apps/vscode test`: which paths a call may name, edits, reads, searches and long output.
- `bun run --cwd apps/vscode test:vscode`: the tools and the change review inside real VS Code, and the side bar's panel framing a stand-in for omp app (the frame rule, the `hello`, the key kept, a tool's call). It downloads VS Code once into `VSCODE_TEST_CACHE` (default `.vscode-test/`) and runs it with no display.
- `apps/web/e2e/v2-vscode-panel.spec.ts`: the panel's page against the real app in Chromium, with a stand-in for VS Code: pairing, the folder's chat without omp's file tools, a tool's call, the open file.
