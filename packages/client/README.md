# @omp-app/client

The browser's end of the omp app's WebSocket: a client that speaks protocol `omp-app/1` to the server, calls its typed ports, subscribes to event streams, and keeps its link alive. The package is private and ships TypeScript source with no build step. Its only dependencies are `@omp-app/contracts` and `zod`.

It uses no DOM, Bun or Node type (`"types": []`), so it can run in a page or in a test: it takes the WebSocket from the global the browser provides, or from the `webSocketFactory` and `timers` options a test passes. How it fits with the rest is in [docs/architecture.md](../../docs/architecture.md#the-wire-between-the-page-and-the-server).

## Entry points

`src/index.ts` re-exports `src/client.ts`, which holds everything:

- `createAppClient({ url, token })` returns an `AppClient`. The `token` is the launch link's secret; a paired device omits it and signs in with its cookie.
- `client.port(Port)` returns a typed proxy of a port from `@omp-app/contracts`: one async function per method, each taking an optional `{ signal }` whose abort sends a `cancel` frame.
- `client.subscribe(Port, event, { scope, afterSeq, onEvent })` subscribes to an event stream and returns a subscription with its last `seq`.
- `client.onConnectionState`, `onResync` and `onOutage` report the state of the link, a stream that could not be resumed, and each outage once the next link's streams are resumed.
- `client.reconnectNow`, `nudge` and `checkLink` let the page speed up or test the link. `apps/ui/src/linkCheck.ts` uses them.
- `client.dispose()` ends the client.

It reconnects by itself (a first try after 100 ms, then doubling up to 5 seconds), drops a try that is not welcomed within 8 seconds, and resubscribes every stream with the last `seq` it saw, so the server replays what was missed or answers `conflict` and the page reads its state again.

## Scripts

From `package.json`:

- `bun run typecheck` runs `tsc` on `src` with `tsconfig.json`, then on `src` and `test` with `tsconfig.test.json`.
- `bun run test` runs `bun test`.

Run them from the root with `bun run --cwd packages/client <script>`.

## Testing

`test/client.test.ts` runs the client against an in-process server, with injected timers and WebSockets, so reconnects, resumed streams, cancellation and the link check are tested without a network:

```bash
bun run --cwd packages/client test
```

See [docs/testing.md](../../docs/testing.md) for the other kinds of test.
