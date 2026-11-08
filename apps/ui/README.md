# @omp-app/ui

The omp app's web UI: a React 19 app built with Vite 8 and styled with Tailwind 4. The server serves its build at its root, the desktop window shows it, and it also serves the lite view at `/lite`, one chat for another app's side panel. The page talks to the server only through `@omp-app/client` and the ports in `@omp-app/contracts`. How the UI is laid out, and how it fits with the server, is in [docs/architecture.md](../../docs/architecture.md#the-ui).

## Entry points

| Path | What it is |
|---|---|
| `index.html` | The page, with a script that sets the theme before the first paint |
| `src/main.tsx`, `src/App.tsx` | The entry, and the root that connects, watches the link and lays out the workspace |
| `src/connection.ts` | Opens the WebSocket at `/ws` on the address that served the page, signed in with the launch link's `#token=` or with the device's cookie |
| `src/chat/` | One chat: `controller.ts` talks to the chat session port and keeps the chat's state, with the composer and the transcript list |
| `src/workspace/` | The tabs, windows and panes, and their saved layouts |
| `src/panels/` | The side panels, each one file registered in `registry.tsx` |
| `src/settings/` | The settings sheet; `omp-settings.json` is generated from the pinned omp by `packages/server/scripts/omp-settings-ui.ts` |
| `src/styles/`, `src/theme/` | The design tokens and the themes ([docs/development.md](../../docs/development.md#design-tokens)) |
| `src/vendor/collab-web/` | Code copied from omp's `collab-web`; its `ORIGIN.md` records the source and every local change. Biome skips it. |

A new panel is one file under `src/panels/` and one line in `src/panels/registry.tsx`, with a tour of its own in `src/tour/tours.ts`.

## Scripts

From `package.json`:

- `bun run dev` starts Vite's dev server. A page it serves has no app server behind it, so use it only with the note in [docs/development.md](../../docs/development.md#working-on-the-ui-alone).
- `bun run typecheck` runs `tsc -b`, which builds the app, the build files and `src/vendor` as three projects.
- `bun run test` runs `vitest run`.
- `bun run themes` rewrites the palette themes in `src/styles/themes.css` from `src/theme/palettes.ts`.
- `bun run build` runs `tsc -b && vite build` and writes `dist/`, the folder the server serves.

Run them from the root with `bun run --cwd apps/ui <script>`; `bun run build` at the root is the same as `build` here.

## Testing

Unit tests are `src/**/*.test.ts` and `.test.tsx`, run by Vitest in Node with no DOM (`vitest.config.ts`). They cover stores, rows, the key table, the link check and the themes, including that every theme's text meets its contrast checks. The page itself is tested by the end-to-end specs in `apps/web`, which run it in Chrome and in WebKit against the real server:

```bash
bun run --cwd apps/ui test
cd apps/ui && bunx vitest run src/linkCheck.test.ts   # one file
```

See [docs/testing.md](../../docs/testing.md) for the end-to-end specs.
