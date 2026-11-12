# apps/zen

omp app's Firefox and Zen extension: omp app's chat in the browser's sidebar, for the tab you open it on. The chat can read and act on that tab, and on tabs it opens itself, and on no other; no other chat in omp app can act on it.

- **The toolbar button** opens the sidebar on the current tab, with that tab's own chat (`src/background.ts`). Each tab has its own panel (`sidebarAction.setPanel` with `?tab=`): switching tabs shows that tab's panel, and coming back reopens its chat. A tab with no chat yet offers **Chat about this tab**, so passing tabs start nothing; the offer follows the tab in front, and binds only the tab it names.
- **The panel** (`src/panel.ts`) shows the lite view with `@omp-app/embed`: it asks once for omp app's address (also in the extension's options), pairs once (the extension keeps the key, as `docs/integrations.md` says), and sends the tab's title, address and selection with each message. The address goes without its query and fragment, where sign-in codes and tokens travel. The key is handed only to the address it was paired with (`src/address.ts`): a new address forgets it, and the panel pairs again.
- **The tools** (`src/tools.ts`, page functions in `src/page.ts`): `read_page`, `screenshot`, `click`, `type`, `scroll`, `navigate`, `open_tab`, `wait_for_text`. Each acts on the panel's own tab, or on a tab it opened with `open_tab`; any other is refused. Firefox's own pages and the add-ons site keep extensions out, and the tool says so.
- **Never omp app's own pages.** The tools do not go to the app's address, and every page function checks the page it runs in and refuses one of the app's: a chat acting there could answer its own approvals, a pairing request or the settings. For an app on the same computer, `localhost`, `127.0.0.1` and `[::1]` at its port all count as its address (`appOrigins`). The extension knows the app only by the address it was given: when the browser runs on the app's own computer and the panel uses the app's HTTPS address, the loopback one (`http://127.0.0.1:4317`) is not refused, and the other way round. `click` says a field's value only for a button (a password the browser filled stays unread), and `read_page` cuts a title, the address and each link at 2,000 characters.

## Build and try

```sh
bun install
bun run --cwd apps/zen build [version]
```

writes the extension to `apps/zen/dist` (Bun 1.3.14 or newer; a version, such as `0.3.1527`, goes into its manifest). In Firefox or Zen, open `about:debugging` → This Firefox → **Load Temporary Add-on…** and choose `dist/manifest.json`. A temporary add-on stays until the browser closes. Nothing needs turning on in omp app: Firefox and Zen extensions may always show the app, and the sidebar pairs once.

**Each release** attaches the extension twice: `omp-app-zen_<version>_unsigned.zip`, for a temporary install, and, once the repository has an addons.mozilla.org API key as its Actions secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`, `omp-app-zen_<version>.xpi`, signed by Mozilla for self-distribution ("unlisted": not shown in its store). Zen installs only signed extensions for good: about:addons → ⚙ → **Install Add-on From File…** and choose the `.xpi`. A newer release's `.xpi` installs over it. The release runs Mozilla's checks (`web-ext lint`) and signs with `web-ext sign --channel unlisted`, sending the repository's source with it for Mozilla's review; a failure leaves the release with the unsigned zip only. `web-ext` comes from `packaging/web-ext`, pinned with every dependency's checksum in its `bun.lock`, and only the signing step has the key.

**What it sends where.** The tab's title, address and selection, and what its tools read, go to the omp app you name in its settings and nowhere else; Firefox asks you to accept that at install (`data_collection_permissions`: browsing activity and website content). It needs Firefox 140 or newer.

## Checks

- `bun run --cwd apps/zen test`: the tab rule, the addresses and each tool against a stand-in browser.
- `apps/web/e2e/v2-zen-page.spec.ts`: the page functions on a real page, called from their source as Firefox calls them.
