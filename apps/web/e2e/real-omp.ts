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
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { expect, type Locator, type Page, test } from "@playwright/test";

const REAL_OMP = "/home/user/.bun/bin/omp";
export const APP_ROOT = resolve(process.cwd(), "../..");
const SERVER_SCRIPT = resolve(APP_ROOT, "packages/server/scripts/dev.ts");
const FAKE_PROVIDER = resolve(APP_ROOT, "packages/omp-rpc/scripts/fake-openai-server.ts");
const SESSION_PATHS = resolve(APP_ROOT, "packages/server/src/modules/A1/sessions/paths.ts");
export const screenshots = resolve(APP_ROOT, ".data/screenshots");

export async function waitForFiniteAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

export interface OpenOptions {
  /** Runs before the app loads, for example to add an init script; its result is ignored. */
  readonly beforeLoad?: (page: Page) => Promise<unknown>;
}

export interface RealApp {
  /** The folder omp runs in. */
  readonly folder: string;
  /** A second, empty folder for tests that switch folders. */
  readonly otherFolder: string;
  /** Opens the app in a new browser page, signed in, and waits for it to render. */
  readonly open: (options?: OpenOptions) => Promise<Page>;
  /** Console errors and uncaught page errors from every page opened so far. A test must end clean. */
  readonly problems: readonly string[];
  /** The process ids of the omp processes the app's server has running right now. */
  readonly ompProcesses: () => readonly number[];
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

function waitForLine(process: ChildProcess, predicate: (line: string) => boolean): Promise<string> {
  const stdout = process.stdout;
  if (!stdout) return Promise.reject(new Error("Child process stdout is unavailable"));
  const reader = createInterface({ input: stdout });
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const timer = setTimeout(() => {
    reader.close();
    reject(new Error("Timed out waiting for child process readiness"));
  }, 30_000);
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
  options: { readonly idleCloseMs: number | undefined; readonly seedSessions: number },
): Promise<{ readonly process: ChildProcess; readonly url: string }> {
  const script = join(root, "app-root-server.ts");
  await writeFile(
    script,
    `import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCompositionServer } from ${JSON.stringify(SERVER_SCRIPT)};
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
const server = await createCompositionServer({
  port: 0,
  cwd: ${JSON.stringify(join(root, "workspace"))},
  env: process.env,
  homeDir: ${JSON.stringify(join(root, "home"))},
  agentDir: ${JSON.stringify(join(root, "agent"))},
  appDataDir: ${JSON.stringify(join(root, "app-data"))},
  ompBin: ${JSON.stringify(REAL_OMP)},
  ompArgs: ["--model", "fake/fake-model"],
  staticRoot: ${JSON.stringify(resolve(APP_ROOT, "apps/web/dist"))},
  idleCloseMs: ${options.idleCloseMs === undefined ? "undefined" : options.idleCloseMs},
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

const enabled = process.env.OMP_APP_REAL_OMP === "1" && existsSync(REAL_OMP);

/**
 * A test with a `realApp` fixture: a fresh composed app per test, torn down afterwards. A spec can
 * shorten how long an unwatched chat's omp process lives with `realTest.use({ idleCloseMs })`, and
 * start with that many old chats already in the folder with `realTest.use({ seedSessions })`.
 */
export const realTest = test.extend<{
  realApp: RealApp;
  idleCloseMs: number | undefined;
  seedSessions: number;
}>({
  idleCloseMs: [undefined, { option: true }],
  seedSessions: [0, { option: true }],
  realApp: async ({ browser, idleCloseMs, seedSessions }, use, testInfo) => {
    testInfo.skip(!enabled, "needs OMP_APP_REAL_OMP=1 and omp installed");
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
    const env = {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      OMP_APP_DATA_DIR: appDataDir,
      ANTHROPIC_API_KEY: ["sk", "ant", "k".repeat(30)].join("-"),
    };
    let provider: ChildProcess | undefined;
    let server: { readonly process: ChildProcess; readonly url: string } | undefined;
    const pages: Page[] = [];
    const problems: string[] = [];
    try {
      provider = await startProvider(agentDir, env);
      server = await startServer(root, env, { idleCloseMs, seedSessions });
      const url = server.url;
      const open = async (options: OpenOptions = {}): Promise<Page> => {
        const page = await browser.newPage();
        pages.push(page);
        page.on("console", (message) => {
          if (message.type() === "error") problems.push(`console error: ${message.text()}`);
        });
        page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
        await options.beforeLoad?.(page);
        await page.goto(url);
        await expect(page.locator("[data-app-root='true']")).toBeVisible();
        return page;
      };
      const serverPid = server.process.pid;
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
      await use({ folder, otherFolder, open, problems, ompProcesses });
      expect(problems).toEqual([]);
    } finally {
      await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
      await stopChild(server?.process);
      if (provider?.stdin) provider.stdin.end();
      await stopChild(provider);
      await rm(root, { recursive: true, force: true });
    }
  },
});

export { expect };
