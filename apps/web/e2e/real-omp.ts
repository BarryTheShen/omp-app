/// <reference types="node" />

/**
 * The real-omp end-to-end harness: every live test runs the composed app (the server from
 * `packages/server/scripts/dev.ts`, real omp, and the fake model in
 * `packages/server/test/fake-provider/fake-openai-server.ts`) in a temporary home, so nothing touches `~/.omp`.
 *
 * Run with `OMP_APP_REAL_OMP=1 bun run e2e -- e2e/<spec>.spec.ts` from `apps/web`, after `bun run build` at the repo root
 * (the server serves `apps/ui/dist`): the global setup (`global-setup.ts`)
 * builds the app's chat host once per lockfile, the omp every live test runs. The fake model
 * answers by keyword in the last user message: `ask_user` makes omp ask "Which database?",
 * `run_bash` makes it run `echo fixture-tool`, `make_todos` makes it write a two-item todo list,
 * `abort_slow` streams slowly, `slow_tool` makes it run a shell command that takes 7 seconds, and
 * anything else is answered "pong".
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { CHAT_HOST_CHAT_ARG } from "@omp-app/contracts/chat-host/args";
import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";

export const APP_ROOT = resolve(process.cwd(), "../..");

/**
 * The omp every live test runs: the app's chat host, omp's own command line compiled from the omp package the app pins
 * (#2586), which the global setup builds and names in `OMP_APP_CHAT_HOST_BIN`. With `OMP_APP_REAL_OMP=1` a missing one
 * fails the live tests rather than skipping them.
 */
export const REAL_OMP = process.env.OMP_APP_CHAT_HOST_BIN ?? "";
const SERVER_SCRIPT = resolve(APP_ROOT, "packages/server/scripts/dev.ts");
const FAKE_PROVIDER = resolve(APP_ROOT, "packages/server/test/fake-provider/fake-openai-server.ts");
const SESSION_PATHS = resolve(APP_ROOT, "packages/server/src/modules/A1/sessions/paths.ts");
const FILE_WATCH_REGISTRY = resolve(
  APP_ROOT,
  "packages/server/src/modules/A1/fs/file-watch-registry.ts",
);
const LOGGING = resolve(APP_ROOT, "packages/server/src/logging/index.ts");
export const screenshots = resolve(APP_ROOT, ".data/screenshots");

/** Waits through the shell's initial layout frames, then until no finite animation or transition is running. */
export async function waitForFiniteAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frame = (): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      requestAnimationFrame(() => resolve());
      return promise;
    };
    await frame();
    await frame();
    let quietFrames = 0;
    while (quietFrames < 8) {
      const running = document
        .getAnimations()
        .some(
          (animation) =>
            animation.playState === "running" &&
            animation.effect?.getComputedTiming().iterations !== Infinity,
        );
      quietFrames = running ? 0 : quietFrames + 1;
      await frame();
    }
  });
}

/** Resize to the phone layout only after both responsive drawers have closed and their transitions are finished. */
export async function narrowTo(
  page: Page,
  size: { readonly width?: number; readonly height?: number } = {},
): Promise<void> {
  await page.setViewportSize({ width: size.width ?? 390, height: size.height ?? 844 });
  await expect(page.locator('[data-shell-layout="narrow"]')).toBeAttached();
  const drawers = page.locator("[data-shell-sidebar]");
  await expect(drawers).toHaveCount(2);
  await expect(drawers.nth(0)).toHaveAttribute("data-open", "false");
  await expect(drawers.nth(1)).toHaveAttribute("data-open", "false");
  await waitForFiniteAnimations(page);
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
  /** Opens the page in this browser context (the same profile, so localStorage is shared) instead of a new one. */
  readonly context?: BrowserContext;
  /** The app's path to open with the launch link (default: `/`, the app's root). */
  readonly path?: string;
  /** The address's query, as `?chat=<id>` (default: none). */
  readonly search?: string;
  /**
   * The address's fragment in place of the launch link's `#token=…`: `""` opens the bare address, as a device that is
   * not paired does; `#pair=<code>` is what a pairing QR code opens.
   */
  readonly hash?: string;
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
  /**
   * Stops the app's server and starts it again on the same port and data. Returns the new launch link, with a new token;
   * the old link expires. `env` sets variables of this and later starts, such as another chat host
   * (`OMP_APP_CHAT_HOST_BIN`, an install of another omp).
   */
  readonly restartServer: (env?: Readonly<Record<string, string>>) => Promise<string>;
  /** Console errors and uncaught page errors from every page opened so far. A test must end clean. */
  readonly problems: readonly string[];
  /** The process ids of the chat processes (each chat's host on omp's SDK) the app's server has running right now. */
  readonly ompProcesses: () => readonly number[];
  /** The app's debug log so far (the same text `omp-app logs` prints). */
  readonly log: () => string;
  /** This run's launch token (the secret in the page's address); it must never be logged. */
  readonly token: string;
  /** For a test that breaks the page on purpose: problems matching this are expected; any other still fails the test. */
  readonly allowProblem: (pattern: RegExp) => void;
  /**
   * Starts another omp in this run's folder, home and agent folder, with the app's environment, for a test that needs a
   * chat held by an omp the app did not start: a second chat host (the app's chat program, its `CHAT_HOST_CHAT_ARG`
   * command), which speaks the app's own protocol (`packages/contracts/src/chat-host/protocol.ts`) on its stdin and
   * stdout and holds a chat the way omp does. Stopped when the test ends.
   */
  readonly startOmp: (args: readonly string[]) => ChildProcess;
}

/** What a test reads from a chat host it started: whether it said hello, and its other lines. */
interface HostLines {
  readonly hello: Promise<void>;
  readonly listeners: Set<(line: Readonly<Record<string, unknown>>) => void>;
}

const HOST_ANSWER_MS = 60_000;
const hostLines = new WeakMap<ChildProcess, HostLines>();

/** Reads a chat host's stdout from its start, so neither its hello nor an early event is missed. */
function readHostLines(child: ChildProcess): void {
  const stdout = child.stdout;
  if (stdout === null) throw new Error("The chat host has no stdout.");
  const hello = Promise.withResolvers<void>();
  const listeners = new Set<(line: Readonly<Record<string, unknown>>) => void>();
  createInterface({ input: stdout }).on("line", (text) => {
    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof line !== "object" || line === null) return;
    const record = line as Readonly<Record<string, unknown>>;
    if (record.kind === "hello") hello.resolve();
    for (const listener of [...listeners]) listener(record);
  });
  hostLines.set(child, { hello: hello.promise, listeners });
}

function linesOf(child: ChildProcess): HostLines {
  const lines = hostLines.get(child);
  if (lines === undefined) throw new Error("This process was not started with realApp.startOmp.");
  return lines;
}

/**
 * Sends one request to a chat host the test started (`realApp.startOmp`) once it has said hello, and resolves with its
 * result; a refused request rejects with the host's error.
 */
export async function hostRequest(
  child: ChildProcess,
  method: string,
  params: Readonly<Record<string, unknown>> = {},
): Promise<unknown> {
  const lines = linesOf(child);
  const stdin = child.stdin;
  if (stdin === null) throw new Error("The chat host has no stdin.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The chat host did not answer ${method}.`)),
      HOST_ANSWER_MS,
    );
  });
  const id = `e2e-${crypto.randomUUID()}`;
  let listener: ((line: Readonly<Record<string, unknown>>) => void) | undefined;
  const answered = new Promise<unknown>((resolve, reject) => {
    listener = (line) => {
      if (line.kind !== "response" || line.id !== id) return;
      if (line.ok === true) resolve(line.result);
      else reject(new Error(`The chat host refused ${method}: ${JSON.stringify(line.error)}`));
    };
    lines.listeners.add(listener);
  });
  try {
    await Promise.race([lines.hello, timedOut]);
    stdin.write(`${JSON.stringify({ kind: "request", id, method, params })}\n`);
    return await Promise.race([answered, timedOut]);
  } finally {
    clearTimeout(timer);
    if (listener !== undefined) lines.listeners.delete(listener);
  }
}

/** Calls `listener` with each event a chat host the test started (`realApp.startOmp`) sends; returns the unsubscribe. */
export function onHostEvent(
  child: ChildProcess,
  listener: (event: Readonly<Record<string, unknown>>) => void,
): () => void {
  const lines = linesOf(child);
  const onLine = (line: Readonly<Record<string, unknown>>): void => {
    if (line.kind !== "event" || typeof line.event !== "object" || line.event === null) return;
    listener(line.event as Readonly<Record<string, unknown>>);
  };
  lines.listeners.add(onLine);
  return () => {
    lines.listeners.delete(onLine);
  };
}

/**
 * Clicks "New chat" and waits for the composer; a new chat starts a real omp process. Its composer shows once that omp
 * has started ("Starting a new chat…" until then): seconds on a quiet machine, over 30 s while many omps start at once.
 */
export async function startChat(page: Page): Promise<Locator> {
  await page
    .locator('[aria-label="Sessions"]')
    .getByRole("button", { name: "New chat" })
    .first()
    .click();
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeVisible({ timeout: 120_000 });
  return composer;
}

/**
 * Starts a new chat in the new UI (`/`) as a person does (#2791). A phone's chat list has New chat, which shows the new
 * chat in place of the one shown. On a desktop New chat belongs to a blank window: the shown workspace's blank window
 * takes it, the focused one first. With none, a workspace of one window has its chat closed (Ctrl+Shift+W: the chat
 * keeps running, in the list), which leaves the blank window a workspace always keeps, as New chat once took the
 * focused pane's place; one of several windows gets a blank window beside it (Ctrl+Shift+O), as a new chat now does.
 */
export async function startNewChat(page: Page): Promise<void> {
  const listButton = page
    .getByRole("navigation", { name: "Chats" })
    .getByRole("button", { name: "New chat" });
  const shown = page.locator("[data-tab]:not([data-hidden])");
  const blank = shown.locator("[data-blank-window]").getByRole("button", { name: "New chat" });
  const focusedBlank = shown
    .locator(".dv-active-group [data-blank-window]")
    .getByRole("button", { name: "New chat" });
  const box = shown.getByRole("textbox", { name: "Message" });
  // The page has drawn: a phone's list, or a desktop's workspace with its blank window or a chat.
  await expect(listButton.or(blank).or(box).first()).toBeVisible({ timeout: 120_000 });
  if (await listButton.isVisible()) {
    await listButton.click();
    return;
  }
  if ((await blank.count()) === 0) {
    const windows = await shown.locator(".dv-groupview").count();
    // One window: closing it leaves the workspace's blank window, unless there are other workspaces, where closing a
    // workspace's only window closes the workspace (#2831): there, as a person would, Ctrl+O starts the chat in a
    // workspace of its own.
    if (windows <= 1 && (await page.locator("[data-tab]").count()) > 1) {
      await page.keyboard.press("Control+o");
      return;
    }
    await page.keyboard.press(windows <= 1 ? "Control+Shift+W" : "Control+Shift+O");
    await expect(blank.first()).toBeVisible();
  }
  await ((await focusedBlank.count()) > 0 ? focusedBlank : blank).first().click();
}

/**
 * Types the prompt and presses Enter, as a person does. A chat that is still opening keeps the text and says so under the
 * box ("Opening session… omp is starting"), and a person waits for that line to go before pressing Enter. The empty chat
 * ("No messages yet.") can already show then.
 */
export async function sendPrompt(composer: Locator, text: string): Promise<void> {
  await composer.fill(text);
  await expect(
    composer
      .page()
      .locator('[data-composer-blocked="true"]')
      .filter({ hasText: "Opening session" }),
  ).toHaveCount(0, { timeout: 120_000 });
  await composer.press("Enter");
}

/**
 * Opens a collapsed tool card the way a person clicks its line. Every call starts as one line, running or finished, so
 * its body (a command's output, a task's transcript, a hub roster) is on the page only once the card opens. A card that
 * is open already is left open.
 */
export async function openToolCard(card: Locator): Promise<void> {
  const line = card.locator('[data-slot="u3-tool-card-trigger"]').first();
  if ((await line.getAttribute("aria-expanded")) !== "true") await line.click();
}

/** Opens every collapsed tool card on the page, one line at a time, as a person would. Bounded: a card that stays closed stops the loop. */
export async function openAllToolCards(page: Page): Promise<void> {
  const collapsed = page.locator('[data-slot="u3-tool-card-trigger"][aria-expanded="false"]');
  for (let opened = 0; opened < 60; opened += 1) {
    if ((await collapsed.count()) === 0) return;
    await collapsed.first().click();
  }
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
    readonly chatWrapper: string | undefined;
    readonly defaultModel: boolean;
    readonly noModel: boolean;
    readonly port: number;
    readonly serverFolder: string;
    readonly fileWatchFailure: "watcher-limit" | undefined;
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
import { FileWatchRegistry } from ${JSON.stringify(FILE_WATCH_REGISTRY)};
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
const fileWatch = ${
      options.fileWatchFailure === "watcher-limit"
        ? `new FileWatchRegistry({
  watchDirectory: () => {
    throw Object.assign(new Error("EMFILE"), { code: "EMFILE" });
  },
})`
        : "undefined"
    };
const server = await createCompositionServer({
  port: ${options.port},
  cwd: ${JSON.stringify(options.serverFolder)},
  env: process.env,
  homeDir: ${JSON.stringify(join(root, "home"))},
  agentDir: ${JSON.stringify(join(root, "agent"))},
  appDataDir: ${JSON.stringify(join(root, "app-data"))},
  // omp's commands come from the chat host this server runs (\`OMP_APP_CHAT_HOST_BIN\`), as an install's do; a spec's
  // \`ompBinary\` replaces them.
  ompBin: ${options.ompBinary === undefined ? "undefined" : JSON.stringify(options.ompBinary)},
  chatWrapper: ${options.chatWrapper === undefined ? "undefined" : JSON.stringify(options.chatWrapper)},
  ompArgs: ${options.noModel || !options.defaultModel ? "[]" : '["--model", "fake/fake-model"]'},
  fileWatch,
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

/**
 * The fake provider turns omp's `native` provider off, and that provider loads skills from the agent folder. A spec that
 * seeds a skill calls this to turn `native` back on; every other provider stays off, as the fake provider has them (#1377).
 */
export async function enableNativeSkills(agentDir: string): Promise<void> {
  await writeFile(
    join(agentDir, "config.yml"),
    [
      "disabledProviders:",
      "  - agents-md",
      "  - agents",
      "  - claude",
      "  - codex",
      "  - gemini",
      "  - github",
      "  - opencode",
      "",
    ].join("\n"),
  );
}

/** Live tests run when `OMP_APP_REAL_OMP=1`; they then need the app's omp, and a missing one fails them, never skips them. */
export const realOmpEnabled = process.env.OMP_APP_REAL_OMP === "1";

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
 * entries } })`. `realTest.use({ ompBinary })` replaces the omp that answers omp's commands (`--version`, `models`,
 * `usage`, `config`), for a spec about omp being missing or answering differently. `realTest.use({ chatWrapper })` runs
 * every chat through a program given the chat's whole command as its arguments, ending with `exec "$@"`: a spec that
 * delays a chat's start, adds arguments to it or filters its frames.
 * Fake files in the agent's `extensions` folder appear in omp's extension catalog: `realTest.use({ seedExtensions: { "name.ts": source } })`.
 * A spec that needs `@` file mentions seeds files with `realTest.use({ seedWorkspace: { files, gitRepo: true } })`; file search lists git files only.
 * A spec that needs omp's environment overrides (for example `PI_AUTO_QA=0`) starts the app with `realTest.use({ serverEnv: { PI_AUTO_QA: "0" } })`.
 * A spec that needs a value omp reads from the agent folder's `.env` file (not the process environment) writes it with `realTest.use({ seedAgentDotEnv: "PI_INTENT_TRACING=0\n" })` before the app starts.
 * A spec can seed files in omp's agent folder before the fake provider and app server start with `realTest.use({ seedAgentFiles: { "RULES.md": text } })`.
 * A notice test can exercise the watcher-limit message with `realTest.use({ fileWatchFailure: "watcher-limit" })`.
 * A spec whose default folder is the home folder, as on the desktop (the server runs in it), uses `realTest.use({ serverInHome: true })`.
 */
export const realTest = test.extend<{
  realApp: RealApp;
  idleCloseMs: number | undefined;
  seedSessions: number;
  seedLongTurn: number;
  seedToolResults: SeedToolResults | undefined;
  seedEntries: SeedEntries | undefined;
  seedExtensions: Readonly<Record<string, string>>;
  seedAgentFiles: Readonly<Record<string, string>>;
  seedAgentDotEnv: string | undefined;
  seedWorkspace: SeedWorkspace | undefined;
  ompBinary: string | undefined;
  chatWrapper: string | undefined;
  defaultModel: boolean;
  noModel: boolean;
  fileWatchFailure: "watcher-limit" | undefined;
  serverPort: number;
  /** Extra environment for the app's server and the omp it starts (omp reads these as overrides). */
  serverEnv: Readonly<Record<string, string>>;
  /** The app's default folder is the home folder: the server runs in it, as on the desktop. */
  serverInHome: boolean;
}>({
  idleCloseMs: [undefined, { option: true }],
  seedSessions: [0, { option: true }],
  seedLongTurn: [0, { option: true }],
  seedToolResults: [undefined, { option: true }],
  seedEntries: [undefined, { option: true }],
  seedExtensions: [{}, { option: true }],
  seedAgentFiles: [{}, { option: true }],
  seedAgentDotEnv: [undefined, { option: true }],
  seedWorkspace: [undefined, { option: true }],
  ompBinary: [undefined, { option: true }],
  chatWrapper: [undefined, { option: true }],
  defaultModel: [true, { option: true }],
  noModel: [false, { option: true }],
  serverPort: [0, { option: true }],
  serverEnv: [{}, { option: true }],
  fileWatchFailure: [undefined, { option: true }],
  serverInHome: [false, { option: true }],
  realApp: async (
    {
      browser,
      idleCloseMs,
      seedSessions,
      seedLongTurn,
      seedToolResults,
      seedEntries,
      seedExtensions,
      seedAgentFiles,
      seedAgentDotEnv,
      seedWorkspace,
      ompBinary,
      chatWrapper,
      defaultModel,
      noModel,
      serverPort,
      serverEnv,
      serverInHome,
      fileWatchFailure,
    },
    use,
    testInfo,
  ) => {
    testInfo.skip(!realOmpEnabled, "needs OMP_APP_REAL_OMP=1");
    if (!existsSync(REAL_OMP)) {
      throw new Error(
        `The app's chat host is not built (OMP_APP_CHAT_HOST_BIN is "${REAL_OMP}"): run the live tests through Playwright, whose global setup builds it, or set OMP_APP_CHAT_HOST_BIN to a compiled one.`,
      );
    }
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
    // Files omp discovers in its agent folder, written before the fake provider and app server start.
    for (const [name, source] of Object.entries(seedAgentFiles)) {
      await writeFile(join(agentDir, name), source);
    }
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
        const target = join(folder, name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, source);
      }
      if (seedWorkspace.gitRepo) execFileSync("git", ["init", "-q"], { cwd: folder });
    }
    // A no-model run has no provider key, so omp has no model and says so.
    const inherited: NodeJS.ProcessEnv = { ...process.env };
    if (noModel)
      for (const key of Object.keys(inherited)) if (key.endsWith("_API_KEY")) delete inherited[key];
    // The running app's own settings on this computer (the address other computers open it at, the pages that frame
    // it, its chat hosts) never reach a test's server: only a spec's `serverEnv` sets them. Nor do the variables the app
    // gives its chats' omp, which a shell inside one of them has: its settings overlay (`PI_CONFIG_FILES`, the app's
    // usage policy) and that chat's session (`PI_SESSION_FILE`, `PI_SESSION_ID`).
    for (const key of [
      "OMP_APP_REMOTE_ORIGIN",
      "OMP_APP_FRAME_ANCESTORS",
      "OMP_APP_HOST_SOCKET",
      "OMP_APP_DETACHED_HOSTS",
      "PI_CONFIG_FILES",
      "PI_SESSION_FILE",
      "PI_SESSION_ID",
    ])
      delete inherited[key];
    const env = {
      ...inherited,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      OMP_APP_DATA_DIR: appDataDir,
      ...(noModel ? {} : { ANTHROPIC_API_KEY: ["sk", "ant", "k".repeat(30)].join("-") }),
      // omp names chats in the app (#2798); specs find their chats by their first message, so omp leaves them unnamed
      // here unless a spec turns it back on (`serverEnv: { PI_NO_TITLE: "" }`).
      PI_NO_TITLE: "1",
      ...serverEnv,
    };
    let provider: ChildProcess | undefined;
    let server: { readonly process: ChildProcess; readonly url: string } | undefined;
    const pages: Page[] = [];
    const contexts: BrowserContext[] = [];
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
        chatWrapper,
        defaultModel,
        noModel,
        port: serverPort,
        serverFolder: serverInHome ? home : folder,
        fileWatchFailure,
      });
      // A port of 0 is a free port picked at each start. The first start's port is kept, so a restart comes back at the
      // same address (and the browser's storage for that address still applies).
      const keptPort = serverPort === 0 ? Number(new URL(server.url).port) : serverPort;
      let url = server.url;
      const open = async (options: OpenOptions = {}): Promise<Page> => {
        const context = options.context ?? (await browser.newContext());
        if (!options.context) contexts.push(context);
        const page = await context.newPage();
        pages.push(page);
        page.on("console", (message) => {
          if (message.type() === "error") problems.push(`console error: ${message.text()}`);
        });
        page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
        await options.beforeLoad?.(page);
        const address = new URL(url);
        address.pathname = options.path ?? "/";
        if (options.search !== undefined) address.search = options.search;
        if (options.hash !== undefined) address.hash = options.hash;
        await page.goto(address.toString());
        if (options.expectApp !== false) {
          // The app's first paint can take that long while other tests' browsers, servers and omps start.
          await expect(page.locator("[data-app-root='true']")).toBeVisible({ timeout: 30_000 });
        }
        return page;
      };
      // A restart keeps the same data, workspace and port, so the app finds its saved state. It returns a new launch link.
      const restartServer = async (next?: Readonly<Record<string, string>>): Promise<string> => {
        await stopChild(server?.process);
        if (next !== undefined) Object.assign(env, next);
        server = await startServer(root, env, {
          idleCloseMs,
          seedSessions,
          seedLongTurn,
          seedToolResults,
          seedEntries,
          ompBinary,
          chatWrapper,
          defaultModel,
          noModel,
          port: keptPort,
          serverFolder: serverInHome ? home : folder,
          fileWatchFailure,
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
        return (
          listing
            .split("\n")
            // Each chat's host runs with this argument (`CHAT_HOST_CHAT_ARG`, contracts `chat-host/args.ts`).
            .filter((line) => line.includes("__omp_app_chat"))
            .map((line) => Number.parseInt(line.trim(), 10))
        );
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
          const child = spawn(REAL_OMP, [CHAT_HOST_CHAT_ARG, ...args], {
            cwd: folder,
            env,
            stdio: ["pipe", "pipe", "pipe"],
          });
          readHostLines(child);
          extraOmp.push(child);
          return child;
        },
      });
      expect(
        problems.filter((problem) => !allowed.some((pattern) => pattern.test(problem))),
      ).toEqual([]);
    } finally {
      await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
      await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
      for (const child of extraOmp) await stopChild(child);
      await stopChild(server?.process);
      if (provider?.stdin) provider.stdin.end();
      await stopChild(provider);
      // A chat's omp can still be writing its last lines as the server stops: a file that appears during the removal
      // makes it fail with ENOTEMPTY, which `rm` retries.
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
});

export { expect };
