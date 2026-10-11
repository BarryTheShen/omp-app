/// <reference types="node" />

/**
 * The real-omp end-to-end harness: every live test runs the composed app (the server from
 * `packages/server/scripts/dev.ts`, real omp, and the fake model in
 * `packages/omp-rpc/scripts/fake-openai-server.ts`) in a temporary home, so nothing touches `~/.omp`.
 *
 * Run with `OMP_APP_REAL_OMP=1 bun run e2e -- e2e/<spec>.spec.ts` from `apps/web`. The fake model
 * answers by keyword in the last user message: `ask_user` makes omp ask "Which database?",
 * `run_bash` makes it run `echo fixture-tool`, `make_todos` makes it write a two-item todo list,
 * `abort_slow` streams slowly, `slow_tool` makes it run a shell command that takes 7 seconds, and
 * anything else is answered "pong".
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { expect, type Locator, type Page, test } from "@playwright/test";

const REAL_OMP = "/home/user/.bun/bin/omp";
export const APP_ROOT = resolve(process.cwd(), "../..");
const SERVER_SCRIPT = resolve(APP_ROOT, "packages/server/scripts/dev.ts");
const FAKE_PROVIDER = resolve(APP_ROOT, "packages/omp-rpc/scripts/fake-openai-server.ts");
const SESSION_PATHS = resolve(APP_ROOT, "packages/server/src/modules/A1/sessions/paths.ts");
const LOGGING = resolve(APP_ROOT, "packages/server/src/logging/index.ts");
export const screenshots = resolve(APP_ROOT, ".data/screenshots");

export async function waitForFiniteAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

/** A tool call and the result omp recorded for it: what `seedToolResults` puts in one chat as one turn each. */
export interface SeedToolResult {
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: { readonly content: readonly unknown[]; readonly details?: unknown };
  readonly isError: boolean;
}

/**
 * The value of the `seedToolResults` option. It is an object around the list, not the list itself:
 * Playwright reads any list whose second item is an object as a `[value, options]` pair and would
 * hand the fixture only the first sample.
 */
export interface SeedToolResults {
  readonly results: readonly SeedToolResult[];
}

/**
 * The value of the `seedEntries` option: one chat made of these raw session entries (`type`, and the
 * fields omp writes for it), in order. An object around the list for the same reason as above.
 */
export interface SeedEntries {
  readonly entries: readonly Record<string, unknown>[];
}

export interface OpenOptions {
  /** Runs before the app loads, for example to add an init script; its result is ignored. */
  readonly beforeLoad?: (page: Page) => Promise<unknown>;
  /** Set to false to open a page that is not the app (a full-page screen such as 'omp isn't available'). */
  readonly expectApp?: boolean;
}

export interface RealApp {
  /** The folder omp runs in. */
  readonly folder: string;
  /** A second, empty folder for tests that switch folders. */
  readonly otherFolder: string;
  /** This harness run's isolated user-level MCP configuration. */
  readonly mcpConfigPath: string;
  /** Opens the app in a new browser page, signed in, and waits for it to render. */
  readonly open: (options?: OpenOptions) => Promise<Page>;
  /** The app's data folder for this run: drafts, attachments and settings. */
  readonly appDataDir: string;
  /** The agent folder for this run (omp's own folder): its config.yml is the settings file a test may write. */
  readonly agentDir: string;
  /** Stops the app's server and starts it again on the same port and data. Returns the new launch link, with a new token; the old link expires. */
  readonly restartServer: () => Promise<string>;
  /** Console errors and uncaught page errors from every page opened so far. A test must end clean. */
  readonly problems: readonly string[];
  /** The process ids of the omp processes the app's server has running right now. */
  readonly ompProcesses: () => readonly number[];
  /** The app's debug log so far (the same text `omp-app logs` prints). */
  readonly log: () => string;
  /** This run's launch token (the secret in the page's address); it must never be logged. */
  readonly token: string;
  /** For a test that breaks the page on purpose: problems matching this are expected; any other still fails the test. */
  readonly allowProblem: (pattern: RegExp) => void;
  /**
   * Starts another omp (`--mode rpc-ui`, the app's mode) in this run's folder, home and agent folder,
   * with the app's environment, for a test that needs a chat held by an omp the app did not start.
   * Stopped when the test ends.
   */
  readonly startOmp: (args: readonly string[]) => ChildProcess;
}

/** Clicks "New chat" and waits for the composer; a new chat starts a real omp process. */
export async function startChat(page: Page): Promise<Locator> {
  await page
    .locator('[aria-label="Sessions"]')
    .getByRole("button", { name: "New chat" })
    .first()
    .click();
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeVisible({ timeout: 30_000 });
  return composer;
}

export async function sendPrompt(composer: Locator, text: string): Promise<void> {
  await composer.fill(text);
  await composer.press("Enter");
}

/**
 * Starting the app's server and a real omp takes seconds on a quiet machine and well over 30 s when many agents run
 * tests at once (load above 40 on 20 cores). The wait ends the moment the line arrives, so a longer limit costs
 * nothing when the start is quick, and only a start that never happens waits the full time. It stays below the
 * 90 s a test gets from `testInfo.slow()`, so a start that never happens reports this error, not a bare timeout.
 */
const READINESS_TIMEOUT_MS = 80_000;

function waitForLine(process: ChildProcess, predicate: (line: string) => boolean): Promise<string> {
  const stdout = process.stdout;
  if (!stdout) return Promise.reject(new Error("Child process stdout is unavailable"));
  const reader = createInterface({ input: stdout });
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const timer = setTimeout(() => {
    reader.close();
    reject(new Error("Timed out waiting for child process readiness"));
  }, READINESS_TIMEOUT_MS);
  process.once("error", (error) => {
    clearTimeout(timer);
    reader.close();
    reject(error);
  });
  process.once("exit", (code) => {
    if (code === 0) return;
    clearTimeout(timer);
    reader.close();
    reject(new Error(`Child process exited before readiness (${code})`));
  });
  reader.on("line", (line) => {
    if (!predicate(line)) return;
    clearTimeout(timer);
    reader.close();
    resolve(line);
  });
  return promise;
}

async function startProvider(agentDir: string, env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn("bun", [FAKE_PROVIDER, agentDir], {
    cwd: agentDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await waitForLine(child, (value) => value.startsWith("READY "));
  return child;
}

async function startServer(
  root: string,
  env: Record<string, string>,
  options: {
    readonly idleCloseMs: number | undefined;
    readonly seedSessions: number;
    readonly seedLongTurn: number;
    readonly seedToolResults: SeedToolResults | undefined;
    readonly seedEntries: SeedEntries | undefined;
    readonly ompBinary: string | undefined;
    readonly noModel: boolean;
    readonly port: number;
  },
): Promise<{ readonly process: ChildProcess; readonly url: string }> {
  const script = join(root, "app-root-server.ts");
  await writeFile(
    script,
    `import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCompositionServer } from ${JSON.stringify(SERVER_SCRIPT)};
import { createLogger } from ${JSON.stringify(LOGGING)};
import { sessionBucketName } from ${JSON.stringify(SESSION_PATHS)};
// Old chats written the way omp writes them, before the app starts.
const seed = ${options.seedSessions};
if (seed > 0) {
  const folder = ${JSON.stringify(join(root, "workspace"))};
  const bucket = join(${JSON.stringify(join(root, "agent"))}, "sessions", sessionBucketName(folder, { home: ${JSON.stringify(join(root, "home"))} }));
  await mkdir(bucket, { recursive: true });
  for (let index = 0; index < seed; index += 1) {
    const id = "01a00000-0000-7000-8000-" + String(index).padStart(12, "0");
    const when = new Date(Date.UTC(2026, 8, 1) + index * 3600000);
    const stamp = when.toISOString();
    const lines = [
      { type: "session", version: 3, id, timestamp: stamp, cwd: folder },
      { type: "message", id: "m" + index, parentId: null, timestamp: stamp, message: { role: "user", content: [{ type: "text", text: "Seeded chat " + (index + 1) }], timestamp: when.getTime() } },
    ];
    const file = join(bucket, stamp.replace(/[:.]/g, "-") + "_" + id + ".jsonl");
    await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\\n") + "\\n");
    await utimes(file, when, when);
  }
}
// One chat with a single very long turn: a user prompt, then this many bash steps, then an answer.
const longTurn = ${options.seedLongTurn};
if (longTurn > 0) {
  const folder = ${JSON.stringify(join(root, "workspace"))};
  const bucket = join(${JSON.stringify(join(root, "agent"))}, "sessions", sessionBucketName(folder, { home: ${JSON.stringify(join(root, "home"))} }));
  await mkdir(bucket, { recursive: true });
  const id = "01a11111-0000-7000-8000-000000000001";
  const when = new Date(Date.UTC(2026, 9, 1));
  const stamp = when.toISOString();
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const lines = [{ type: "session", version: 3, id, timestamp: stamp, cwd: folder }];
  let parent = null;
  let count = 0;
  const add = (message) => {
    const entryId = "e" + String(count++).padStart(6, "0");
    lines.push({ type: "message", id: entryId, parentId: parent, timestamp: stamp, message });
    parent = entryId;
  };
  add({ role: "user", content: [{ type: "text", text: "Run the long job" }], timestamp: when.getTime() });
  for (let step = 0; step < longTurn; step += 1) {
    add({ role: "assistant", content: [{ type: "toolCall", id: "call_" + step, name: "bash", arguments: { command: "echo step-" + step } }], api: "openai-completions", provider: "fake", model: "fake-model", usage, stopReason: "toolUse", timestamp: when.getTime() });
    add({ role: "toolResult", toolCallId: "call_" + step, toolName: "bash", content: [{ type: "text", text: "step-" + step }], isError: false, timestamp: when.getTime() });
  }
  add({ role: "assistant", content: [{ type: "text", text: "All " + longTurn + " steps are done." }], api: "openai-completions", provider: "fake", model: "fake-model", usage, stopReason: "stop", timestamp: when.getTime() });
  const file = join(bucket, stamp.replace(/[:.]/g, "-") + "_" + id + ".jsonl");
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\\n") + "\\n");
  await utimes(file, when, when);
}
// One chat from real tool results (a list of { toolName, args, result: { content, details }, isError }):
// every sample is its own turn, so the cards are rendered by the real history loader and the real registry.
const samples = ${JSON.stringify(options.seedToolResults?.results ?? [])};
if (samples.length > 0) {
  const folder = ${JSON.stringify(join(root, "workspace"))};
  const bucket = join(${JSON.stringify(join(root, "agent"))}, "sessions", sessionBucketName(folder, { home: ${JSON.stringify(join(root, "home"))} }));
  await mkdir(bucket, { recursive: true });
  const id = "01a22222-0000-7000-8000-000000000002";
  const when = new Date(Date.UTC(2026, 9, 2));
  const stamp = when.toISOString();
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const lines = [{ type: "session", version: 3, id, timestamp: stamp, cwd: folder }];
  let parent = null;
  let count = 0;
  const add = (message) => {
    const entryId = "e" + String(count++).padStart(6, "0");
    lines.push({ type: "message", id: entryId, parentId: parent, timestamp: stamp, message });
    parent = entryId;
  };
  const base = { api: "openai-completions", provider: "fake", model: "fake-model", usage, timestamp: when.getTime() };
  samples.forEach((sample, index) => {
    const callId = "call_" + index;
    add({ role: "user", content: [{ type: "text", text: "sample " + index + ": " + sample.toolName }], timestamp: when.getTime() });
    add({ ...base, role: "assistant", content: [{ type: "toolCall", id: callId, name: sample.toolName, arguments: sample.args ?? {} }], stopReason: "toolUse" });
    add({ role: "toolResult", toolCallId: callId, toolName: sample.toolName, content: sample.result.content, ...(sample.result.details === undefined ? {} : { details: sample.result.details }), isError: sample.isError === true, timestamp: when.getTime() });
    add({ ...base, role: "assistant", content: [{ type: "text", text: "end of sample " + index }], stopReason: "stop" });
  });
  const file = join(bucket, stamp.replace(/[:.]/g, "-") + "_" + id + ".jsonl");
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\\n") + "\\n");
  await utimes(file, when, when);
}
// One chat of raw session entries (the harness adds id and parentId, and a time to an entry without one).
const seededEntries = ${JSON.stringify(options.seedEntries?.entries ?? [])};
if (seededEntries.length > 0) {
  const folder = ${JSON.stringify(join(root, "workspace"))};
  const bucket = join(${JSON.stringify(join(root, "agent"))}, "sessions", sessionBucketName(folder, { home: ${JSON.stringify(join(root, "home"))} }));
  await mkdir(bucket, { recursive: true });
  const id = "01a33333-0000-7000-8000-000000000003";
  const when = new Date(Date.UTC(2026, 9, 3));
  const stamp = when.toISOString();
  const lines = [{ type: "session", version: 3, id, timestamp: stamp, cwd: folder }];
  let parent = null;
  seededEntries.forEach((entry, index) => {
    const entryId = "e" + String(index).padStart(6, "0");
    lines.push({ ...entry, id: entryId, parentId: parent, timestamp: entry.timestamp ?? stamp });
    parent = entryId;
  });
  const file = join(bucket, stamp.replace(/[:.]/g, "-") + "_" + id + ".jsonl");
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\\n") + "\\n");
  await utimes(file, when, when);
}
const server = await createCompositionServer({
  port: ${options.port},
  cwd: ${JSON.stringify(join(root, "workspace"))},
  env: process.env,
  homeDir: ${JSON.stringify(join(root, "home"))},
  agentDir: ${JSON.stringify(join(root, "agent"))},
  appDataDir: ${JSON.stringify(join(root, "app-data"))},
  ompBin: ${JSON.stringify(options.ompBinary ?? REAL_OMP)},
  ompArgs: ${options.noModel ? "[]" : '["--model", "fake/fake-model"]'},
  staticRoot: ${JSON.stringify(resolve(APP_ROOT, "apps/web/dist"))},
  idleCloseMs: ${options.idleCloseMs === undefined ? "undefined" : options.idleCloseMs},
  logger: createLogger({ dir: ${JSON.stringify(join(root, "logs"))} }),
  statsIntervalMs: 1000,
});
console.log("APP_ROOT_READY " + JSON.stringify({ url: server.url, token: server.token }));
const stop = () => void server.stop().finally(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
`,
  );
  const child = spawn("bun", [script], {
    cwd: APP_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = await waitForLine(child, (value) => value.startsWith("APP_ROOT_READY "));
  const launch = JSON.parse(line.slice("APP_ROOT_READY ".length)) as { url: string; token: string };
  return { process: child, url: `${launch.url}/#token=${encodeURIComponent(launch.token)}` };
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  child.once("exit", () => resolve());
  child.kill("SIGTERM");
  await promise;
}

export const realOmpEnabled = process.env.OMP_APP_REAL_OMP === "1" && existsSync(REAL_OMP);

/** Files for the chat's workspace folder, and whether that folder is a git repository (`git init`). */
export interface SeedWorkspace {
  readonly files: Readonly<Record<string, string>>;
  readonly gitRepo: boolean;
}

/**
 * A test with a `realApp` fixture: a fresh composed app per test, torn down afterwards. A spec can
 * shorten how long an unwatched chat's omp process lives with `realTest.use({ idleCloseMs })`, and
 * start with that many old chats already in the folder with `realTest.use({ seedSessions })`, or with
 * one chat holding a single turn of that many steps with `realTest.use({ seedLongTurn })`, or with one
 * chat made of recorded tool results with `realTest.use({ seedToolResults: { results } })` (one turn
 * each, in order), or with one made of raw session entries with `realTest.use({ seedEntries: {
 * entries } })`. A spec
 * about omp being missing points the app at another binary with `realTest.use({ ompBinary })`.
 * Fake files in the agent's `extensions` folder appear in omp's extension catalog: `realTest.use({ seedExtensions: { "name.ts": source } })`.
 * A spec that needs `@` file mentions seeds files with `realTest.use({ seedWorkspace: { files, gitRepo: true } })`; file search lists git files only.
 * A spec that needs omp's environment overrides (for example `PI_AUTO_QA=0`) starts the app with `realTest.use({ serverEnv: { PI_AUTO_QA: "0" } })`.
 * A spec that needs a value omp reads from the agent folder's `.env` file (not the process environment) writes it with `realTest.use({ seedAgentDotEnv: "PI_INTENT_TRACING=0\n" })` before the app starts.
 */
export const realTest = test.extend<{
  realApp: RealApp;
  idleCloseMs: number | undefined;
  seedSessions: number;
  seedLongTurn: number;
  seedToolResults: SeedToolResults | undefined;
  seedEntries: SeedEntries | undefined;
  seedExtensions: Readonly<Record<string, string>>;
  seedAgentDotEnv: string | undefined;
  seedWorkspace: SeedWorkspace | undefined;
  ompBinary: string | undefined;
  noModel: boolean;
  serverPort: number;
  /** Extra environment for the app's server and the omp it starts (omp reads these as overrides). */
  serverEnv: Readonly<Record<string, string>>;
}>({
  idleCloseMs: [undefined, { option: true }],
  seedSessions: [0, { option: true }],
  seedLongTurn: [0, { option: true }],
  seedToolResults: [undefined, { option: true }],
  seedEntries: [undefined, { option: true }],
  seedExtensions: [{}, { option: true }],
  seedAgentDotEnv: [undefined, { option: true }],
  seedWorkspace: [undefined, { option: true }],
  ompBinary: [undefined, { option: true }],
  noModel: [false, { option: true }],
  serverPort: [0, { option: true }],
  serverEnv: [{}, { option: true }],
  realApp: async (
    {
      browser,
      idleCloseMs,
      seedSessions,
      seedLongTurn,
      seedToolResults,
      seedEntries,
      seedExtensions,
      seedAgentDotEnv,
      seedWorkspace,
      ompBinary,
      noModel,
      serverPort,
      serverEnv,
    },
    use,
    testInfo,
  ) => {
    testInfo.skip(!realOmpEnabled, "needs OMP_APP_REAL_OMP=1 and omp installed");
    // Real omp starts a process per chat: a loaded machine needs more than the default 30 s.
    testInfo.slow();
    await mkdir(resolve(APP_ROOT, ".data"), { recursive: true });
    const root = await mkdtemp(join(resolve(APP_ROOT, ".data"), "real-omp-e2e-"));
    const home = join(root, "home");
    const agentDir = join(root, "agent");
    const appDataDir = join(root, "app-data");
    const folder = join(root, "workspace");
    const otherFolder = join(root, "other-workspace");
    await Promise.all([home, agentDir, appDataDir, folder, otherFolder].map((path) => mkdir(path)));
    // A value omp reads from the agent folder's `.env`, written before the app and its server start.
    if (seedAgentDotEnv !== undefined) await writeFile(join(agentDir, ".env"), seedAgentDotEnv);
    // Fake files for omp's extension catalog: a file in `<agent>/extensions` is listed as an extension.
    if (Object.keys(seedExtensions).length > 0) {
      await mkdir(join(agentDir, "extensions"));
      for (const [name, source] of Object.entries(seedExtensions)) {
        await writeFile(join(agentDir, "extensions", name), source);
      }
    }
    // Files for the chat's workspace folder, in a git repository when the spec asks for one.
    if (seedWorkspace !== undefined) {
      for (const [name, source] of Object.entries(seedWorkspace.files)) {
        await writeFile(join(folder, name), source);
      }
      if (seedWorkspace.gitRepo) execFileSync("git", ["init", "-q"], { cwd: folder });
    }
    // A no-model run has no provider key, so omp has no model and says so (see chat-no-model.spec.ts).
    const inherited: NodeJS.ProcessEnv = { ...process.env };
    if (noModel)
      for (const key of Object.keys(inherited)) if (key.endsWith("_API_KEY")) delete inherited[key];
    const env = {
      ...inherited,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      OMP_APP_DATA_DIR: appDataDir,
      ...(noModel ? {} : { ANTHROPIC_API_KEY: ["sk", "ant", "k".repeat(30)].join("-") }),
      ...serverEnv,
    };
    let provider: ChildProcess | undefined;
    let server: { readonly process: ChildProcess; readonly url: string } | undefined;
    const pages: Page[] = [];
    const extraOmp: ChildProcess[] = [];
    const problems: string[] = [];
    const allowed: RegExp[] = [];
    try {
      provider = noModel ? undefined : await startProvider(agentDir, env);
      server = await startServer(root, env, {
        idleCloseMs,
        seedSessions,
        seedLongTurn,
        seedToolResults,
        seedEntries,
        ompBinary,
        noModel,
        port: serverPort,
      });
      let url = server.url;
      const open = async (options: OpenOptions = {}): Promise<Page> => {
        const page = await browser.newPage();
        pages.push(page);
        page.on("console", (message) => {
          if (message.type() === "error") problems.push(`console error: ${message.text()}`);
        });
        page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
        await options.beforeLoad?.(page);
        await page.goto(url);
        if (options.expectApp !== false) {
          await expect(page.locator("[data-app-root='true']")).toBeVisible();
        }
        return page;
      };
      // A restart keeps the same data, workspace and port, so the app finds its saved state. It returns a new launch link.
      const restartServer = async (): Promise<string> => {
        await stopChild(server?.process);
        server = await startServer(root, env, {
          idleCloseMs,
          seedSessions,
          seedLongTurn,
          seedToolResults,
          seedEntries,
          ompBinary,
          noModel,
          port: serverPort,
        });
        url = server.url;
        serverPid = server.process.pid;
        return url;
      };
      let serverPid: number | undefined = server.process.pid;
      const ompProcesses = (): readonly number[] => {
        if (serverPid === undefined) return [];
        let listing: string;
        try {
          listing = execFileSync("ps", ["-o", "pid=,args=", "--ppid", String(serverPid)], {
            encoding: "utf8",
          });
        } catch {
          return []; // ps exits with status 1 when the server has no child processes
        }
        return listing
          .split("\n")
          .filter((line) => line.includes("--mode rpc-ui"))
          .map((line) => Number.parseInt(line.trim(), 10));
      };
      const logFile = join(root, "logs", "omp-app.log");
      const log = (): string => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");
      await use({
        folder,
        otherFolder,
        mcpConfigPath: join(agentDir, "mcp.json"),
        open,
        problems,
        ompProcesses,
        log,
        get token() {
          return decodeURIComponent(new URL(url).hash.replace(/^#token=/, ""));
        },
        restartServer,
        appDataDir,
        agentDir,
        allowProblem: (pattern) => void allowed.push(pattern),
        startOmp: (args) => {
          const child = spawn(ompBinary ?? REAL_OMP, ["--mode", "rpc-ui", ...args], {
            cwd: folder,
            env,
            stdio: ["pipe", "pipe", "pipe"],
          });
          extraOmp.push(child);
          return child;
        },
      });
      expect(
        problems.filter((problem) => !allowed.some((pattern) => pattern.test(problem))),
      ).toEqual([]);
    } finally {
      await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
      for (const child of extraOmp) await stopChild(child);
      await stopChild(server?.process);
      if (provider?.stdin) provider.stdin.end();
      await stopChild(provider);
      await rm(root, { recursive: true, force: true });
    }
  },
});

export { expect };
