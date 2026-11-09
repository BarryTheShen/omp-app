# apps/zen

omp app's Firefox and Zen extension: omp app's chat in the browser's sidebar, for the tab you open it on. The chat can read and act on that tab, and on tabs it opens itself, and on no other; no other chat in omp app can act on it.

- **The toolbar button** opens the sidebar on the current tab, with that tab's own chat (`src/background.ts`). Each tab has its own panel (`sidebarAction.setPanel` with `?tab=`): switching tabs shows that tab's panel, and coming back reopens its chat. A tab with no chat yet offers **Chat about this tab**, so passing tabs start nothing.
- **The panel** (`src/panel.ts`) shows the lite view with `@omp-app/embed`: it asks once for omp app's address (also in the extension's options), pairs once (the extension keeps the key, as `docs/integrations.md` says), and sends the tab's title, address and selection with each message.
- **The tools** (`src/tools.ts`, page functions in `src/page.ts`): `read_page`, `screenshot`, `click`, `type`, `scroll`, `navigate`, `open_tab`, `wait_for_text`. Each acts on the panel's own tab, or on a tab it opened with `open_tab`; any other is refused. Firefox's own pages and the add-ons site keep extensions out, and the tool says so.

## Build and try

```sh
bun run --cwd apps/zen build
```

writes the extension to `apps/zen/dist`; each release also has it as `omp-app-zen_<version>_unsigned.zip`. In Firefox or Zen, open `about:debugging` → This Firefox → **Load Temporary Add-on…** and choose `dist/manifest.json` (or the zip). A temporary add-on stays until the browser closes. In omp app, turn on **Settings → App → Integrations → Firefox and Zen extensions** first, so the sidebar may show the app.

A lasting install needs Mozilla's signature: Zen installs only signed extensions. Mozilla signs an "unlisted" extension (not shown in its store) with an addons.mozilla.org account's API key, for example with Mozilla's `web-ext sign --channel unlisted` run on `dist/`.

## Checks

- `bun run --cwd apps/zen test`: the tab rule, the addresses and each tool against a stand-in browser.
- `apps/web/e2e/v2-zen-page.spec.ts`: the page functions on a real page, called from their source as Firefox calls them.
