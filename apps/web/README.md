# @omp-app/web

The omp app's end-to-end tests. Despite the name, this package is not the web app (that is `apps/ui`): it holds Playwright specs that open the real app in a browser, on the real server and the real chat host, with a fake model in place of a provider. The package is private and has no build step. Its only dependency is `@omp-app/contracts`.

How the tests are put together, and everything they need, is in [docs/testing.md](../../docs/testing.md#the-end-to-end-tests). How the parts they exercise fit together is in [docs/architecture.md](../../docs/architecture.md).

## Entry points

| Path | What it is |
|---|---|
| `playwright.config.ts` | The configuration: specs in `e2e/`, system Chrome, headless, parallel, no web server (each spec starts its own) |
| `e2e/global-setup.ts` | Runs once per run and builds the compiled chat host, when `OMP_APP_REAL_OMP=1` |
| `e2e/real-omp.ts` | The `realTest` fixture and its helpers: a fresh server, fake model and throwaway home, agent and data folders for each test |
| `e2e/*.spec.ts` | The specs, one per feature |
| `e2e/*-checks.ts` | Checks shared by a spec for Chrome and one for WebKit (`v2-math-checks.ts`, for example) |

The fake model's trigger words are in `packages/server/test/fake-provider/fake-openai-server.ts` and are listed in [docs/testing.md](../../docs/testing.md#the-fake-model-provider).

## Scripts

From `package.json`:

- `bun run typecheck` runs `tsc -p tsconfig.json` over `e2e` and the config.
- `bun run e2e` runs `playwright test`.

## Running the tests

Every `realTest` is skipped unless `OMP_APP_REAL_OMP=1` is set. The server serves the built UI, so build it first. To run one spec:

```bash
bun run build                                              # at the repo root
cd apps/web
OMP_APP_REAL_OMP=1 bunx playwright test e2e/v2-core.spec.ts
```

Specs whose names end in `-webkit.spec.ts` run in Playwright's WebKit: install it once with `bunx playwright install webkit`. The tests use throwaway folders under `.data` in the checkout, so they never touch your own omp settings or chats. A package's own unit tests are separate: see [docs/testing.md](../../docs/testing.md).
