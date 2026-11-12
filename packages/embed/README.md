# @omp-app/embed

The library a host uses to show omp app's chat in its panel: a browser extension's side panel, an editor's webview, a notes app, a web page. `openPanel` makes the frame of the app's lite view, says hello each time the panel loads, sends settings, what is open and tools, answers each call of a tool with its handler, and keeps the panel's key where the host keeps it.

- `src/index.ts`: `openPanel`, and the `HostTool`, `KeyKeeper`, `PanelOptions` and `Panel` types. Only types come from `@omp-app/contracts`, so the built module has no other code.
- `bun run build` writes `dist/omp-embed.js`, one ES module for a host to load or bundle.

[docs/integrations.md](../../docs/integrations.md) says which pages may frame the app (browser extensions and VS Code always may), how a panel signs in, the protocol, and shows a minimal host page. `apps/web/e2e/v2-embed-hosts.spec.ts` runs that page against the real app.
