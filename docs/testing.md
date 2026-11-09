# Testing

The kinds of test the repository has, what each needs, and how to run it. To set up a checkout first, see [development.md](development.md). For the parts a test exercises, see [architecture.md](architecture.md).

| Kind | Where | Runs with | Needs |
|---|---|---|---|
| Unit tests | `packages/*`, `apps/ui` | `bun run test` | Bun |
| Real-omp tests | `packages/server/test/e2e`, one in `packages/server/src/process` | `OMP_APP_REAL_OMP=1 bun test <file>` | Bun, `bun` on the path |
| End-to-end specs | `apps/web/e2e` | `OMP_APP_REAL_OMP=1 bunx playwright test <spec>` in `apps/web` | The built UI, Chrome, Bun, and the network on the first run (to fetch Bun 1.4.3) |
| Package checks | `packaging/*.sh`, `apps/desktop/src-tauri` | CI and the commands in [releasing.md](releasing.md) | A built package, a virtual display |

None of the slower kinds runs unless asked. A bare `bun run test` starts no real omp and no browser.

## Unit tests

- **The packages** (`packages/contracts`, `packages/client`, `packages/server`) use Bun's test runner: `bun test` in each. Tests sit beside the code they cover in `packages/server/src/**/*.test.ts`, and in `test/` folders in each package. `packages/server/scripts/omp-settings-ui.test.ts` also fails while the UI's copy of omp's settings is stale ([development.md](development.md#the-pinned-omp-release)).
- **The UI** (`apps/ui`) uses Vitest (`vitest run`, configured in `apps/ui/vitest.config.ts`). It runs `src/**/*.test.ts` and `.test.tsx` in Node with no DOM, so it covers stores, rows, key tables, the link check and the themes' contrast, not rendering.
- **Test doubles.** `packages/server/src/process/test-fixtures/fake-omp.ts` stands in for a chat process: it says `hello` and answers every request, and does what the `FAKE_OMP_*` variables ask (write to stderr, exit with a code, ignore SIGTERM). `packages/server/src/test-fixtures/ui/` is a small built-UI stand-in for the server's tests of what it serves.

```bash
bun run test                                    # every workspace's unit tests
bun run --cwd packages/server test              # one workspace
bun test packages/server/src/dispatcher.test.ts # one file (a bare `bun test` runs only the packages: see bunfig.toml)
cd apps/ui && bunx vitest run src/linkCheck.test.ts
```

## Real-omp tests

These start the real chat host on omp's SDK, with a fake model instead of a provider. Each test is skipped unless `OMP_APP_REAL_OMP=1` is set, because starting a chat takes seconds and varies under load.

```bash
OMP_APP_REAL_OMP=1 bun test packages/server/test/e2e/real-omp.test.ts
OMP_APP_REAL_OMP=1 bun test packages/server/test/e2e/sdk-chat-host.test.ts
```

- `packages/server/test/e2e/real-omp.test.ts` composes the whole server (`createCompositionServer` in `packages/server/scripts/dev.ts`) and drives a chat through the app's client.
- `packages/server/test/e2e/sdk-chat-host-*.test.ts` test the chat host alone, through `ChatHostClient`, with the harness in `sdk-chat-host-harness.ts`: a fresh home and agent folder per chat, the fake model, and the host run from source and, when `OMP_APP_CHAT_HOST_BIN` names one, compiled too. `sdk-chat-host-tui.test.ts` also needs `tmux` and `script`.
- `packages/server/test/e2e/d2-detached-hosts.test.ts` covers hosts that outlive the server.
- Every test starts the fake model with `bun`, so `bun` must be on the path.

### The fake model provider

`packages/server/test/fake-provider/fake-openai-server.ts <agentDir>` is an OpenAI-compatible chat-completions server on 127.0.0.1, on a free port. It prints `READY <port>` once it listens and stops when its stdin closes. On start it writes two files into the agent folder it is given:

- `config.yml`, which turns off omp's discovery providers (so a chat starts the same on any machine; `FAKE_OPENAI_ENABLE_RULES=1` leaves the `native` one on) and sets a short retry delay;
- `models.yml`, a provider `fake` with the models `fake-model` (the one every test uses, as `fake/fake-model`; it reasons), `fake-vision` (accepts images), a few `claude-*` models and one with a very long name. `FAKE_EXTRA_MODELS=<n>` adds a provider `many` with `<n>` more models.

It logs each request body to `requests.jsonl` in the folder above the agent folder.

**How it answers.** The reply depends on the words in the latest user message, matched as plain substrings, case-sensitive, in the order of the code (`reply` in the file): the first rule that matches wins. A message with none of the words gets **`pong`**. When the latest message is a tool's result, the reply is `tool said: <the result>`, except in the scripted multi-step rules below, which carry on through their tool calls. A word followed by a number takes it as seconds where the table says so.

Words that make the model call a tool:

| Word | What the model does |
|---|---|
| `run_bash` | Runs `echo fixture-tool` with bash |
| `run_failing_bash` | Runs `ls /nonexistent-omp-fixture`, which exits non-zero |
| `run_git_stash` | Runs `git stash` |
| `slow_tool [n]` | Runs `sleep n; echo slow-tool-done` (7 seconds by default) |
| `intent_probe [n]` | Runs a command with an intent line, "Waiting for the fixture command to finish", sleeping `n` seconds (6 by default) |
| `burst_output_tool` | Runs a command that prints 20 lines and ends |
| `streaming_output_tool` | Runs a command that prints five lines, waits 2 seconds, then prints `stream-done` |
| `serve_probe` | Starts a tiny web server on a free port in the background, for at most a minute; it answers `served-by-chat` |
| `read_long_probe`, `read_image` | Reads `long.txt`, or `pixel.png`, in the chat's folder |
| `read_pasted_reference local://paste-<n>.md` | Reads that reference once, then answers `reference read` |
| `read_attached_file` | Reads the first `local://` reference in the message once, then answers `reference read` |
| `call_tool <name> <json>` | Calls the tool `<name>` with the JSON arguments (a host tool, or `read` of a host URI), then answers `tool said: …` |
| `make_todos` | Writes a todo list of two items under "Plan" |
| `make_long_todos` | Writes a todo list with long item names, in two phases |
| `run_queued_pair` | Sends a `sleep 20` bash call and a `write` in one message (the write starts after the bash) |
| `long_loop` | Takes 60 bash steps (`echo loop-<n>`) in one turn, then answers `loop finished` |
| `wait_for_jobs` | Calls the `wait` tool, which waits for background jobs |

Words that start background jobs (each job is a bash call with `async`, so the turn ends while the job runs on):

| Word | What the model does |
|---|---|
| `run_background_job`, `run_background_pair` | Starts one, or two, jobs that sleep for 120 seconds |
| `run_quick_background` | Starts one job that ends after 2 seconds |
| `run_second_background` | Starts one more long job, with a call id of its own |
| `run_stale_background` | Starts three jobs: one ends after 4 seconds, one runs 15 minutes, one ends after 25 seconds |
| `run_stale_then_wait` | The same three, then a `wait` in the same turn |
| `usage_limit_after_job <tag>` | Starts a 2-second job; the turn its result starts is refused once with a usage-limit style error and a wait of 61 seconds |
| `usage_limit_twice <tag>` | Starts a 4-second job; its own turn is refused once (61 seconds), then the turn its result starts is refused once (5 seconds) |
| `usage_limit_job_running <tag>` | Starts a 15-minute job and a 2-second one; the short job's result turn is refused once while the long job runs on |

Words that start subagents (the `task` tool). The child's own task text carries a word of its own (`nested_probe_child`, `wait_probe_child`, `fail_probe_child`, `stream_probe_child`, `quiet_probe_child`, `long_probe_child`, `held_probe_child`, `intent_child`, `nested_steer_child`, `nested_parent_probe`), which is how the fake model knows what the child should do; a test does not type these.

| Word | What the model does |
|---|---|
| `spawn_subagent` | Starts one child that returns a short result with `yield` |
| `spawn_wait_subagent` | Starts one child, then collects it with `wait` |
| `spawn_failing_subagent` | Starts a child whose model call fails |
| `spawn_stream_failing_subagent` | Starts a child that streams one line of text, after a slow step, and then its stream fails |
| `spawn_quiet_subagent` | Starts a child that answers in plain text and never calls `yield` |
| `spawn_long_subagent` | Starts a child that runs one 60-second step |
| `spawn_held_subagent` | Starts a child whose command runs until the file `release-long-probe` appears in the agent folder (at most four minutes) |
| `spawn_steerable_subagent` | Starts a child that keeps taking one-second steps until a message beginning `steer_probe:` reaches it |
| `spawn_nested_probe` | Starts a worker that starts a nested worker and then waits about 30 seconds |
| `spawn_intent_subagent [n]`, `spawn_foreground_intent [n]` | Starts a child that runs one bash step with an intent for `n` seconds (6 by default); the second child blocks its parent |
| `spawn_slow_with_sleep` | Starts a slow worker and a 10-second bash call in one message |

Words that make the model ask the person a question (the `ask` tool):

| Word | The question |
|---|---|
| `ask_user` | "Which database?", Postgres or SQLite |
| `ask_recommended` | The same, with SQLite recommended |
| `ask_three` | Three questions with short headers, descriptions, a preview, one with several answers, and a recommended answer |
| `ask_six` | Six questions with longer headers, more tabs than a narrow chat fits |
| `ask_long_word` | One question whose text, an option label and an option description each hold a 100-character word |
| `checkbox_ask_one`, `checkbox_ask_two` | A multi-select question "Which tools should run?", alone, or after a single-choice one |

Words that make a plan (plan mode): `plan_propose` writes a plan to `local://fix-the-login-plan.md` and submits it for review; `plan_write_outside` tries to write a file outside the plan, which omp's plan-mode guard refuses.

Words that shape a text reply:

| Word | The reply |
|---|---|
| `abort_slow` | `slow-stream` with some reasoning, sent slowly, so a test can stop it |
| `stream_code` | A short fenced TypeScript block, streamed in pieces of 12 characters, 40 ms apart |
| `stream_long_code` | A block longer than the code view's short-block limit (2,048 characters), streamed |
| `stream_held` | The same long block, held open after eight lines until the file `release-held-reply` appears in the agent folder (at most four minutes) |
| `stream_steady` | 240 lines streamed over about a minute, to keep a turn open |
| `stream_reasoning` | About fourteen seconds of streamed reasoning, then `The answer after the reasoning.` |
| `stream_math`, `math_shapes` | Math in every notation (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`), streamed; and a boxed result with a brace under a sum |
| `make_it_big` | 1,100,000 characters |
| `long_reply_probe` | Forty paragraphs |
| `long_word_probe` | A 306-character word with no spaces |
| `link_probe` | A Markdown link, a bare URL, and a link whose text names a different host than its address |
| `link_wrap_probe <n>` | A link whose text is `n` characters plus `.example.test` |
| `table_probe` | Two Markdown tables, one with a very long address |
| `count_reply <word>` | `count-<n> <word>`, where `n` counts these replies across the whole fake server |
| `context_has <word>` | `context has <word>` or `context lacks <word>`, depending on whether an earlier message sent to the model holds the word |

Words that make the provider fail: `retry_failure_probe` (a retryable 503), `provider_failure_long` (a 400 with a very long message), `runtime_failure_long` (partial text, then the stream fails with a long message), `auth_probe` and `auth_probe_long` (a 401, "Invalid API key"). A latest message that holds `cache_warm` or `cache_cold` also changes the usage the reply reports: 800 tokens read from the prompt cache, or 800 written to it. Two more rules answer omp's own requests to name a chat: `<title-request>` gets a title ("Fake chat title marker"), and a message that starts with `<chat>` gets "Fake old chat title".

## The end-to-end tests

The specs in `apps/web/e2e` open the real app in a browser, on the real server and the real chat host, with the fake model. Each spec file is named for what it covers (`v2-core.spec.ts`, `v2-pairing.spec.ts`, `v2-scroll.spec.ts`, …).

### How a run is put together

- **Build the UI first.** The server serves `apps/ui/dist`, so run `bun run build` at the root after any UI change.
- **The global setup** (`apps/web/e2e/global-setup.ts`) runs once before the workers start. When `OMP_APP_REAL_OMP=1` and `OMP_APP_CHAT_HOST_BIN` is not set, it builds the compiled chat host and puts its path in `OMP_APP_CHAT_HOST_BIN`, which the workers inherit, so every live test runs the program the packages ship. The build is kept in `.data/chat-host` in the checkout (or in `OMP_APP_CHAT_HOST_DIR`), under a name made from a hash of `bun.lock`, the build script, `chat-host-bun.ts`, the sources of the chat host and of `packages/contracts`, and the manifests of `packages/server` and `packages/contracts`; it is rebuilt only when one of them changes, and a lock folder keeps parallel runs from building it twice. The build needs Bun 1.4.3: `OMP_APP_CHAT_HOST_BUN` names one, otherwise the setup downloads it once from Bun's releases and checks it against the release's `SHASUMS256.txt`.
- **The `realTest` fixture** (`apps/web/e2e/real-omp.ts`) gives each test a `realApp`: a fresh composed app. Without `OMP_APP_REAL_OMP=1` every `realTest` is skipped.
- **Throwaway folders.** Each test makes a folder `real-omp-e2e-<random>` under `.data` in the checkout (git-ignored) with `home`, `agent`, `app-data`, `workspace`, `other-workspace` and `logs` in it, and runs everything with `HOME`, `PI_CODING_AGENT_DIR` and `OMP_APP_DATA_DIR` set to those, so a test never touches your own omp settings or chats. It starts the fake model for the agent folder, then a server (`createCompositionServer`) on a free port with `--model fake/fake-model`, and removes the folder at the end. omp's own chat naming is off (`PI_NO_TITLE=1`) unless a spec turns it back on.
- **A test must end clean.** `realApp.problems` collects every console error and uncaught page error; the test fails if any remain that `realApp.allowProblem` did not allow.
- **Options** are set per spec file with `realTest.use({ ... })`: `seedSessions`, `seedLongTurn`, `seedToolResults`, `seedEntries` (old chats), `seedExtensions`, `seedAgentFiles`, `seedAgentDotEnv`, `seedWorkspace` (files, optionally a git repository), `serverEnv` (environment for the server and its omp), `serverPort`, `serverInHome`, `idleCloseMs`, `ompBinary`, `chatWrapper`, `defaultModel`, `noModel`, `fileWatchFailure`. The header comment of `real-omp.ts` explains each. `realApp` also offers `open`, `restartServer`, `ompProcesses`, `log`, `startOmp` (another chat host on the same folders) and the folders and token of the run.
- **Helpers** in the same file: `startNewChat`, `startChat`, `sendPrompt`, `openToolCard`, `narrowTo` (the phone layout), `hostRequest` and `onHostEvent` (talk to a chat host a test started), and `screenshots`.

### The browsers

`apps/web/playwright.config.ts` defines no named projects. Specs run in the system's Google Chrome (`channel: "chrome"`, headless). A spec runs in Playwright's own WebKit with `realTest.use({ browserName: "webkit", channel: "" })`; the specs whose names end in `-webkit.spec.ts` do. Install it once with `bunx playwright install webkit` in `apps/web`. A feature tested in both engines keeps its checks in a `*-checks.ts` file (`v2-math-checks.ts`), and two short specs call it, one per engine. Specs for phones and tablets emulate them with `viewport`, `hasTouch` and `isMobile` in their own context options.

### Where the output goes

Screenshots a spec saves go to `.data/screenshots` in the checkout (the `screenshots` export of `real-omp.ts`), a git-ignored folder. Playwright's own traces (kept on a test's first retry) go to `apps/web/test-results`, and its reports to `playwright-report`, both git-ignored.

### Running one spec

```bash
bun run build                                              # at the repo root: the server serves apps/ui/dist
cd apps/web
OMP_APP_REAL_OMP=1 bunx playwright test e2e/v2-core.spec.ts
OMP_APP_REAL_OMP=1 bun run e2e -- e2e/v2-core.spec.ts      # the same, through the package script
```

Add `-g "<part of a test's title>"` to run one test. The suite runs in parallel: `E2E_WORKERS` sets the number of workers, and a `--workers` flag wins over it. With `CI` set, Playwright forbids `test.only` and retries a failed test twice.

## The variables used only by tests and the build

These are not settings for a person running the app (those are in [configuration.md](configuration.md)).

| Variable | Meaning |
|---|---|
| `OMP_APP_REAL_OMP` | `1` turns on the tests that start a real chat host: the real-omp tests and every `realTest` spec. It also makes the e2e global setup build the compiled chat host. |
| `OMP_APP_CHAT_HOST_BIN` | The path of a compiled chat host. The server and the `omp-app` launcher run it as omp (the launcher falls back to the installed one, and from source to the chat host's entry on Bun), and the desktop window sets it to its bundled one. The e2e global setup sets it for the workers; set it yourself to use a host you built. |
| `OMP_APP_CHAT_HOST_DIR` | Where the e2e global setup keeps compiled chat hosts and the Bun it downloads. Default: `.data/chat-host` in the checkout. |
| `OMP_APP_CHAT_HOST_BUN` | The Bun 1.4.3 binary the e2e global setup compiles the chat host with. Without it the setup downloads one. (The packaging scripts and the workflows use `CHAT_HOST_BUN` for the same purpose.) |
| `OMP_APP_PROBE_SECRET` | Set by one unit test (`packages/server/src/modules/A1/config/omp-defaults.test.ts`) as a canary. It checks that the probe of omp's setting defaults runs omp in its own home, agent and temporary folders with none of the server's environment, so the canary must not reach the probe. No app code reads it. |
| `OMP_APP_HOST_SOCKET` | The socket a detached chat host listens on, as an older server passed it in the environment. `packages/server/src/chat-host/chat.ts` still reads it when `--app-host-socket=<path>` is absent. It is one of the server's own switches that never reach a chat's environment, and `d2-detached-hosts.test.ts` checks that. |
| `OMP_APP_VERSION` | Not an environment variable: a constant that `bun build --compile --define` writes into the `omp-app` command in `packaging/build-deb.sh` and `packaging/build-desktop-deb.sh`. It is the version `omp-app --version` prints; from source it is `dev`. |
| `OMP_APP_UI_ROOT` | The folder of the built UI that the `omp-app` launcher serves. The launcher looks there first, then beside the installed command, then in the checkout's `apps/ui/dist`. The desktop window sets it to its bundled UI when it starts its server. |

Other switches the tests use: `OMP_APP_DETACHED_HOSTS=1` (hosts that outlive the server) and `OMP_APP_NEW_CHATS_READY=1` (keep a new chat ready; off in tests unless set), `OMP_APP_HANDBACK_MS` (how long a detached host waits for its server before it hands its chat back), `OMP_APP_SHARE_ADDRESS` (the address shares open at, in place of the computer's Tailscale address), `OMP_APP_BROWSER_NO_SANDBOX=1` (the app's Chrome without its sandbox, for a container that cannot start it), `OMP_APP_VSCODE` and `OMP_APP_VSCE` (a VS Code for Linux and the command that packs its extension, for `v2-vscode-real.spec.ts`), `E2E_WORKERS`, `FAKE_OPENAI_ENABLE_RULES` and `FAKE_EXTRA_MODELS` (the fake model).

## The desktop checks

The window is checked in three layers:

- **Rust.** In `apps/desktop/src-tauri`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test`. The build script must have run once first, because the crate bundles inputs it creates ([apps/desktop/README.md](../apps/desktop/README.md)).
- **The package smoke test.** `packaging/desktop-smoke-test.sh <package.deb>` unpacks the package and runs the window under a virtual display and a private session bus. It refuses to run on a real display. It checks that the window opens and the app loads; that closing the window, SIGTERM and a killed window each end the app and leave the server running; that a second launch attaches to the running server and starts no second one; that the error pages show when the web app or the server is missing or dies; that a long turn (`slow_tool`, with the fake model) finishes after its window closed and the reopened window attaches to it; `--remote` and `--local`; more windows (Ctrl+Shift+N, `--new-window`); undo with Ctrl+Z; pasting a copied file; and links to a chat (`omp-app://chat/…`), which show it in the open window, and open nothing for a server the app never opened. Screenshots go to a `screenshots` folder beside the package.
- **By hand.** [apps/desktop/README.md](../apps/desktop/README.md) lists three checks that need a person at a real desktop.

`packaging/smoke-test.sh <package.deb>` does the same for the terminal command's package: it unpacks it into a temporary folder and checks the command's version, the UI it serves, a second launch finding the first, the debug log and its commands, the chat host (omp's own smoke test, and a chat that stops at omp's model check), the user service, the instance record and a link that survives a restart. Both scripts and how to run them are in [releasing.md](releasing.md#checking-a-package).

## What CI runs

There are two workflows (`.github/workflows/`), and neither runs the typecheck, the lint, the unit tests or the end-to-end specs. Run those yourself before you push ([CONTRIBUTING.md](../CONTRIBUTING.md)).

- **`desktop.yml`** runs on pull requests that change `apps/desktop/**`, `packaging/build-desktop-deb.sh` or `packaging/desktop-smoke-test.sh`, and by hand. It checks the Rust formatting, builds the desktop package, runs clippy and `cargo test`, smoke-tests the package under a virtual display and uploads it as a build artifact.
- **`release.yml`** runs twice a day and by hand. It builds and smoke-tests both packages before it publishes anything. See [releasing.md](releasing.md).
