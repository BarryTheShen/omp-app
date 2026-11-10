# Development

How to set up a checkout, run the app from source, and work on each part. For how the parts fit together, read [architecture.md](architecture.md) first. For tests, see [testing.md](testing.md). For a change you want merged, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Prerequisites

- **[Bun](https://bun.sh) 1.3.14 or later.** The repository is a Bun workspace; the release workflow builds with exactly 1.3.14. Bun is the only package manager, runtime and test runner for the packages.
- **Bun 1.4.4, only to build the chat host.** The chat host is compiled with the Bun release that omp's own release is built with, and `packages/server/scripts/build-chat-host.ts` refuses any other (`CHAT_HOST_BUN_VERSION` in `packages/server/scripts/chat-host-bun.ts`). You need it to build a package, and the end-to-end tests fetch it for you (see [testing.md](testing.md#the-variables-used-only-by-tests-and-the-build)). Running from source does not need it.
- **Rust (stable), only for the desktop window** in `apps/desktop`, with `rustfmt` and `clippy`, and the Linux libraries Tauri 2 needs. The exact packages and commands are in [apps/desktop/README.md](../apps/desktop/README.md).
- **Google Chrome, and Playwright's WebKit,** only for the end-to-end tests. The specs run in the system's Chrome; the specs whose names end in `-webkit` run in Playwright's WebKit, which you install once with `bunx playwright install webkit` in `apps/web`.

The packages and the compiled chat host target Linux on x86-64 (`linux-x64`, `amd64`).

## Setup

```bash
git clone https://github.com/BarryTheShen/omp-app.git
cd omp-app
bun install        # installs every workspace, and the omp release the app pins
```

`bun install` also installs omp itself, as the `@oh-my-pi/*` packages: the app runs that release and never an omp installed on your computer.

## The root scripts

These are the scripts in the root `package.json`:

| Command | What it does |
|---|---|
| `bun run build` | Builds the UI (`tsc -b && vite build` in `apps/ui`) into `apps/ui/dist`, which the server serves |
| `bun run dev` | Runs `build`, then starts the server from source (see below) |
| `bun run typecheck` | Runs the `typecheck` script of every workspace that has one |
| `bun run test` | Runs the `test` script of every workspace that has one: Bun's test runner in the packages, Vitest in `apps/ui` |
| `bun run lint` | `biome check .`: lint, formatting and import order, without changing files |
| `bun run format` | `biome format --write .`: rewrites files to the formatting rules |

The end-to-end tests are not part of `bun run test`; see [testing.md](testing.md).

## Running from source

```bash
bun run dev
```

`bun run dev` builds the UI, then runs `packages/server/scripts/dev.ts`. That script is the server's composition root (`createCompositionServer`): when run directly it starts the real server and prints the app's link, `http://127.0.0.1:4317/#token=<token>`. Open it in a browser. What to know:

- **The port** is 4317, or the value of `OMP_APP_PORT`. Unlike the `omp-app` command, this entry does not look for a free port. If the app is already running on 4317 (the installed user service, for example), stop it first with `systemctl --user stop omp-app`, or give the source run another port.
- **Which omp.** The omp package pinned in `packages/server/package.json`, from your `node_modules`, run on the Bun that runs the server: omp's command line answers omp's own commands, and each chat runs `packages/server/src/chat-host/main.ts` on that Bun. That is for development only; the installed app runs one compiled chat host. To run chats on a compiled one, build it with Bun 1.4.4 and name it:

  ```bash
  /path/to/bun-1.4.4/bun packages/server/scripts/build-chat-host.ts /path/to/chat-host
  OMP_APP_CHAT_HOST_BIN=/path/to/chat-host bun run dev
  ```
- **Your own chats and settings.** The server uses your home folder: omp's agent folder (`~/.omp/agent`, or `PI_CODING_AGENT_DIR`) and the app data folder in it (`app`, or `OMP_APP_DATA_DIR`). Chats you start are real chats in your own folders. To keep a source run apart from them, point `PI_CODING_AGENT_DIR` at another folder; omp then finds none of your settings (`config.yml`) or model definitions (`models.yml`) there.
- **A new token every start,** because this entry keeps none, and no browser is opened.
- **No debug log.** `dev.ts` creates no logger, so nothing is written to the log file, the page's errors included, and **Save debug log** says "The debug log is off in this run of the app."
- **No watching.** None of the scripts watch files. Restart the server after changing server code, and run `bun run build` after changing the UI.

To run the same launcher the installed `omp-app` command runs (instance record, kept token, free-port fallback, debug log, `tui`, `pair` and the rest), from your checkout:

```bash
bun run build
bun packages/server/scripts/omp-app.ts --no-open     # add a folder to work in, or --help for every option
```

If the app already runs for your user, the launcher attaches to it and prints its link instead of starting a second server.

### Working on the UI alone

`apps/ui` has a `dev` script (`bun run --cwd apps/ui dev`, Vite's dev server), but a page served by it has no server behind it: the page opens its WebSocket at `/ws` on the address that served it (`apps/ui/src/connection.ts`), and `apps/ui/vite.config.ts` sets up no proxy to the app's server. The way to work on the UI against a real server is the one above: change the UI, run `bun run build`, and reload the page the server serves. Without a server, `bun run --cwd apps/ui typecheck` and `bun run --cwd apps/ui test` cover the UI's types and its unit tests.

## Each workspace and its scripts

Run a workspace's script from the root with `bun run --cwd <folder> <script>`, or `bun run --filter <package name> <script>`.

| Folder | Package | Scripts |
|---|---|---|
| `packages/contracts` | `@omp-app/contracts` | `typecheck` (`tsc` on `src` with `tsconfig.json`, then on the tests with `tsconfig.test.json`), `test` (`bun test`) |
| `packages/client` | `@omp-app/client` | `typecheck` (as above), `test` (`bun test`) |
| `packages/server` | `@omp-app/server` | `typecheck` (`tsc -p tsconfig.json`), `test` (`bun test`) |
| `apps/ui` | `@omp-app/ui` | `dev` (`vite`), `typecheck` (`tsc -b`), `test` (`vitest run`), `themes` (`bun scripts/write-themes.ts`), `build` (`tsc -b && vite build`) |
| `apps/web` | `@omp-app/web` | `typecheck` (`tsc -p tsconfig.json`), `e2e` (`playwright test`) |
| `apps/desktop` | `@omp-app/desktop` | `tauri` (the Tauri command line); the Rust code is checked with `cargo` in `apps/desktop/src-tauri` |

Other scripts you may need:

- `packages/server/scripts/omp-app.ts` is the `omp-app` command; `packages/server/scripts/build-chat-host.ts` compiles the chat host.
- `bun packages/server/scripts/omp-settings-ui.ts` rewrites `apps/ui/src/settings/omp-settings.json`, the UI's copy of omp's settings definitions, from the pinned omp.
- `packaging/*.sh` build and check the Debian packages: [releasing.md](releasing.md).

A bare `bun test` at the root runs only the packages' tests: `bunfig.toml` sets the test root to `packages`.

## Code style

[Biome](https://biomejs.dev) is the one tool for linting and formatting, configured in `biome.json`:

- the formatter uses two-space indentation, a line width of 100, double quotes and semicolons;
- the linter uses Biome's recommended rules, and the assist that organizes imports is on, so `biome check` also reports imports out of order;
- it reads `.gitignore`, and skips `apps/ui/src/vendor`, which is copied code;
- two files have an accessibility rule switched off (`apps/ui/public/favicon.svg` and `apps/ui/src/components/ui/input-group.tsx`).

Run `bun run lint` before you push; it fails on anything `bun run format` would change. The desktop window's Rust follows `cargo fmt`, and `cargo clippy --all-targets -- -D warnings` must pass.

## TypeScript

`tsconfig.base.json` holds the settings every workspace extends: target and library ES2023, `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax` (a type is imported with `import type`), `isolatedModules`, and `noEmit` (the checker never writes files). What each workspace adds:

- `packages/contracts` and `packages/client` load no ambient types (`"types": []`), so a Bun, Node or DOM name in their `src` fails the typecheck. Their tests use `tsconfig.test.json`, which adds Bun's types. See [packages/contracts/README.md](../packages/contracts/README.md).
- `packages/server` loads Bun's types, and `apps/web` Node's.
- `apps/ui` is three projects (`tsconfig.app.json` for the app, `tsconfig.node.json` for the build files, `tsconfig.vendor.json` for `src/vendor`) that `tsc -b` builds together. The app project adds the DOM library, `noUnusedLocals` and `noUnusedParameters`, and `erasableSyntaxOnly`, so no enums or parameter properties. `@/` means `apps/ui/src`.

## Adding things

### A port method

A port is declared once in `packages/contracts` and implemented once in `packages/server`; see [the wire](architecture.md#ports-and-the-dispatcher).

1. In the port's contract (`packages/contracts/src/ports/A1/<port>.ts`, or `src/ports/A0/` for the server's live state), add the method to `definePort({ methods })` with its `args` and `result` schemas, and a `capability` when it needs one. The port's file is exported from `packages/contracts/src/ports/A1/index.ts` (or `A0/index.ts`).
2. Implement it. For an `A1` port, add the handler in `packages/server/src/modules/A1/ports/<port>.ts` (`createA1PortRegistration`), over the store in `packages/server/src/modules/A1/`. For an `A0` port, the handler is in `packages/server/src/ports/A0/`. The registry throws at start when a registration lacks a handler for one of the port's methods or has one the port does not declare (`packages/server/src/registry/ports.ts`).
3. A new port needs one more step: add its registration to `createA1PortRegistrations` in `packages/server/src/modules/A1/ports/index.ts` (an `A0` port is composed in `packages/server/scripts/dev.ts`). A `host.*` capability a port declares must also be in `DEFAULT_HOST_CAPABILITIES` in `packages/server/src/capabilities/index.ts`, or the page sees it as unavailable; `packages/server/src/modules/A1/ports/ports.test.ts` fails when one is missing.
4. Call it from the page with `client.port(ThePort).method(args)` (`packages/client/src/client.ts`), and add tests beside the handler and in `packages/contracts/test/`.

### A chat host method

A method of the protocol between the server and each chat ([the chat host protocol](architecture.md#the-chat-host-protocol)):

1. Add its name to `CHAT_HOST_METHOD_NAMES` in `packages/contracts/src/chat-host/method-names.ts`. That list also makes the capability key `omp.cmd.<method>`.
2. In `packages/contracts/src/chat-host/protocol.ts`, define its params schema, add it to `ChatHostMethodMap` with its `params` and `result` types, and add the schema to the `PARAMS` table. The compiler fails when a method is missing from the name list, the map or the table.
3. In `packages/server/src/chat-host/loop.ts`, add its handler to the `handlers` table, which is typed so that a missing handler fails the typecheck. A method that must be answered while other work runs (a long command, a cancel) also goes in `BACKGROUND_METHODS` in the same file.
4. The page calls it through `A0.chatSession.request` with the chat, the method name and the params. Start-up checks list the method from the host's `hello`, so no list needs another edit; a cached result that lacks a method is not used (`packages/server/src/probe-cache.ts`).
5. Test it against the fake model with the real-omp tests in `packages/server/test/e2e/` (`sdk-chat-host-*.test.ts` and `sdk-chat-host-harness.ts`): [testing.md](testing.md#real-omp-tests).

### The pinned omp release

The omp release the app runs is pinned in `packages/server/package.json`, with the same version in the `@oh-my-pi/*` entries of `packages/contracts/package.json` and `apps/ui/package.json`. Moving to another release means updating all of them together, then:

- `OMP_FLOOR_VERSION` in `packages/contracts/src/core/omp.ts`, which `packages/server/src/omp-host/omp-version.test.ts` keeps equal to the pin;
- `CHAT_HOST_BUN_VERSION` in `packages/server/scripts/chat-host-bun.ts`, if the Bun inside omp's release changed, and the Bun versions `release.yml` and `desktop.yml` download for the chat host;
- `apps/ui/src/settings/omp-settings.json`, with `bun packages/server/scripts/omp-settings-ui.ts`; `packages/server/scripts/omp-settings-ui.test.ts` fails while it is stale.

## Design tokens

The UI has one design system: colors, type, radii, easing and icons come from the design tokens, never from a literal in a component.

- `apps/ui/src/styles/themes.css` defines the tokens as CSS variables under the names of Tern's design kit: the text levels `--t1` to `--t4`, the lines `--l1` to `--l4`, the surfaces `--page`, `--panel` and `--raise`, the accent and the status colors (`--ok`, `--warn`, `--bad`, `--live`), the radii (`--r-chip`, `--r-ctl`, `--r-card`, `--r-panel`), the fonts (`--sans`, `--mono`) and the easing curves. Each theme is a `[data-theme]` block that sets the same names.
- `apps/ui/src/styles/index.css` maps the tokens to Tailwind (`text-t2`, `bg-page`, `border-l2`, `text-accent-ink` and so on) and to shadcn's roles.
- The palette themes are generated: edit `apps/ui/src/theme/palettes.ts`, then run `bun run --cwd apps/ui themes`, which writes the block between the palette-theme markers in `themes.css` (`apps/ui/scripts/write-themes.ts`). `apps/ui/src/theme/derive.test.ts` fails while the file and the palettes disagree, and `apps/ui/src/styles/themes.test.ts` checks the contrast of every theme.
- Icons come from `lucide-react`, the fonts from `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`, and the building blocks in `apps/ui/src/components/ui/` are shadcn-style components (`apps/ui/components.json`) on Base UI.

## Tests

Unit tests, the real-omp tests and the end-to-end specs are described in [testing.md](testing.md).
