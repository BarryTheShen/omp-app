# @omp-app/server

The omp app's server: a Bun process that listens on 127.0.0.1, serves the built UI, speaks to each page over a WebSocket of typed ports, and runs one chat host (omp's SDK in its own process) per open chat. It also holds the stores behind the ports and the `omp-app` command.

The package is private and has no build step: scripts and sources run on Bun. How it fits with the rest is in [docs/architecture.md](../../docs/architecture.md).

## Entry points

| Path | What it is |
|---|---|
| `scripts/dev.ts` | The composition root (`createCompositionServer`): asks omp for its version, capabilities and setting defaults, then builds the process registry, the stores and the port registry. Run directly (`bun run dev` at the root), it starts a server and prints its link. |
| `scripts/omp-app.ts` | The installed `omp-app` command: one instance per user, the kept launch token, the debug log, and `tui`, `pair`, `devices`, `logs` and `debug-report` |
| `scripts/build-chat-host.ts` | Compiles the chat host from the pinned omp package, on the Bun omp's release is built with (`scripts/chat-host-bun.ts`) |
| `scripts/omp-settings-ui.ts` | Rewrites the UI's copy of omp's settings definitions from the pinned omp |
| `src/server.ts` | `createAppServer`: HTTP, the `/ws` WebSocket, the Host, Origin and token checks, static files |
| `src/dispatcher.ts`, `src/replay.ts` | Turns frames into port calls and streams; numbers events and keeps what a reconnecting page missed |
| `src/registry/ports.ts` | The port registry |
| `src/chat-host/` | The chat host program (`main.ts` is its entry; `loop.ts` answers the server's requests) and the server's client for it (`client.ts`) |
| `src/process/` | Starting chat hosts, one per chat (`registry.ts`), and hosts that outlive the server (`detached-process.ts`) |
| `src/ports/A0/` | The handlers of the server's live ports: chats, running chats, devices, shares, the app's browser, app info |
| `src/modules/A1/` | The stores and gateways behind the `A1` ports: session files, config, drafts, checkpoints, rules, and more |
| `src/capabilities/` | The start-up checks of omp and the capability map |
| `src/devices/`, `src/launcher/`, `src/logging/`, `src/browser/` | Device pairing, the command's subcommands, the debug log, and the app's browser and the relay |

## Scripts

From `package.json`:

- `bun run typecheck` runs `tsc -p tsconfig.json` over `src`, `test` and `scripts`.
- `bun run test` runs `bun test`.

Run them from the root with `bun run --cwd packages/server <script>`.

## Testing

Unit tests sit beside the code in `src/**/*.test.ts`, and `test/` holds the tests that start a real chat host (`test/e2e`, skipped unless `OMP_APP_REAL_OMP=1`) and the fake model they use (`test/fake-provider`):

```bash
bun run --cwd packages/server test
OMP_APP_REAL_OMP=1 bun test packages/server/test/e2e/real-omp.test.ts
```

[docs/testing.md](../../docs/testing.md) lists the fake model's words and the variables the tests use.
