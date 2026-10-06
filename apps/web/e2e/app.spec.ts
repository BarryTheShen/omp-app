/// <reference types="node" />

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { expect, type Page, test } from "@playwright/test";

const REAL_OMP = "/home/user/.bun/bin/omp";
const APP_ROOT = resolve(process.cwd(), "../..");
const SERVER_SCRIPT = resolve(APP_ROOT, "packages/server/scripts/dev.ts");
const FAKE_PROVIDER = resolve(APP_ROOT, "packages/omp-rpc/scripts/fake-openai-server.ts");
const screenshots = resolve(APP_ROOT, ".data/screenshots");
async function waitForFiniteAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}
const realTest = process.env.OMP_APP_REAL_OMP === "1" && existsSync(REAL_OMP) ? test : test.skip;

interface ReadyProvider {
  readonly process: ChildProcess;
  readonly port: number;
}

function waitForLine(process: ChildProcess, predicate: (line: string) => boolean): Promise<string> {
  const stdout = process.stdout;
  if (!stdout) return Promise.reject(new Error("Child process stdout is unavailable"));
  const reader = createInterface({ input: stdout });
  return new Promise((resolveLine, reject) => {
    const close = () => reader.close();
    const timer = setTimeout(() => {
      close();
      reject(new Error("Timed out waiting for child process readiness"));
    }, 30_000);
    process.once("error", (error) => {
      clearTimeout(timer);
      close();
      reject(error);
    });
    process.once("exit", (code) => {
      if (code === 0) return;
      clearTimeout(timer);
      close();
      reject(new Error(`Child process exited before readiness (${code})`));
    });
    reader.on("line", (line) => {
      if (!predicate(line)) return;
      clearTimeout(timer);
      close();
      resolveLine(line);
    });
  });
}

async function startProvider(
  agentDir: string,
  env: Record<string, string>,
): Promise<ReadyProvider> {
  const child = spawn("bun", [FAKE_PROVIDER, agentDir], {
    cwd: agentDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const line = await waitForLine(child, (value) => value.startsWith("READY "));
  return { process: child, port: Number(line.slice("READY ".length)) };
}

async function startServer(
  root: string,
  env: Record<string, string>,
): Promise<{ readonly process: ChildProcess; readonly url: string }> {
  const script = join(root, "app-root-server.ts");
  await writeFile(
    script,
    `import { createCompositionServer } from ${JSON.stringify(SERVER_SCRIPT)};
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
  child.kill("SIGTERM");
  await new Promise<void>((resolveStop) => child.once("exit", () => resolveStop()));
}

realTest(
  "creates, chats, reloads session and draft, and captures styled themes",
  async ({ browser }) => {
    const root = await mkdtemp(join(resolve(APP_ROOT, ".data"), "app-root-e2e-"));
    const home = join(root, "home");
    const agentDir = join(root, "agent");
    const appDataDir = join(root, "app-data");
    const folder = join(root, "workspace");
    const otherFolder = join(root, "other-workspace");
    await Promise.all([
      mkdir(home),
      mkdir(agentDir),
      mkdir(appDataDir),
      mkdir(folder),
      mkdir(otherFolder),
    ]);
    const fakeKey = ["sk", "ant", "k".repeat(30)].join("-");
    const env = {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      OMP_APP_DATA_DIR: appDataDir,
      ANTHROPIC_API_KEY: fakeKey,
    };
    let provider: ReadyProvider | undefined;
    let server: { readonly process: ChildProcess; readonly url: string } | undefined;
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    try {
      provider = await startProvider(agentDir, env);
      server = await startServer(root, env);
      const page = await browser.newPage();
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(server.url);
      await expect(page.locator("[data-app-root='true']")).toBeVisible();
      const folderPicker = page.getByRole("combobox", { name: "Workspace folder" });
      await expect(folderPicker).toHaveValue(folder);
      await folderPicker.selectOption("__other__");
      await page.getByRole("textbox", { name: "Other folder path" }).fill(otherFolder);
      await page.getByRole("button", { name: "Use" }).click();
      await expect(folderPicker).toHaveValue(otherFolder);
      await expect(page.getByText("No sessions in this folder")).toBeVisible();
      await folderPicker.selectOption(folder);
      await page
        .locator('[aria-label="Sessions"]')
        .getByRole("button", { name: "New chat" })
        .first()
        .click();
      await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible();
      // The fake provider answers a prompt containing "run_bash" with a bash tool call
      // (`echo fixture-tool`) and then "tool said: fixture-tool" (packages/omp-rpc/scripts/fake-openai-server.ts).
      const promptText = "Please run_bash and tell me what it printed.";
      const messageInput = page.getByRole("textbox", { name: "Message input" });
      await messageInput.fill(promptText);
      await messageInput.press("Enter");
      const toolCard = page.locator('[data-testid^="tool-card-"]');
      const userMessage = page
        .locator('[data-slot="u1-message-row"][data-role="user"]')
        .filter({ hasText: promptText });
      const assistantMessages = page.locator('[data-slot="u1-message-row"][data-role="assistant"]');
      await expect(page.getByText("tool said: fixture-tool")).toBeVisible({ timeout: 45_000 });
      await expect(userMessage).toBeVisible();
      // After sending, the cursor stays in the composer so the next message can be typed at once.
      await expect(messageInput).toBeFocused();
      await expect(toolCard.first()).toBeVisible();
      // The bash card shows the command's output (omp's bash tool result), not a waiting state.
      await expect(page.getByTestId("u3-bash-stdout")).toContainText("fixture-tool");
      await expect(page.getByText("Waiting for bash output…")).toHaveCount(0);
      await expect(assistantMessages.last()).toBeVisible();
      await expect(page.getByText("Assistant is working…")).toBeHidden({ timeout: 45_000 });
      await expect(page.getByText("Loading conversation…")).toBeHidden();
      await expect(page.getByText("Nothing here yet")).toBeVisible();
      await expect(page.getByText("No todos yet.")).toHaveCount(0);
      await page.getByRole("textbox", { name: "Message input" }).fill("draft survives reload");
      const background = await page
        .locator("[data-shell-layout]")
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(background).not.toBe("rgba(0, 0, 0, 0)");
      await mkdir(screenshots, { recursive: true });
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, "app-root-light.png"), fullPage: true });
      await page.reload();
      await expect(page.getByRole("combobox", { name: "Workspace folder" })).toHaveValue(folder);
      await expect(page.getByRole("textbox", { name: "Message input" })).toHaveValue(
        "draft survives reload",
      );
      await expect(
        page
          .locator('[data-slot="u1-message-row"][data-role="user"]')
          .filter({ hasText: promptText }),
      ).toBeVisible();
      // omp hasn't titled the session, so the sidebar names it after the first prompt.
      await expect(
        page.getByRole("listbox", { name: "Session list" }).getByRole("option").first(),
      ).toContainText(promptText);
      await expect(page.locator('[data-testid^="tool-card-"]').first()).toBeVisible();
      await expect(
        page.locator('[data-slot="u1-message-row"][data-role="assistant"]').last(),
      ).toBeVisible();
      await expect(page.getByText("Loading conversation…")).toBeHidden();

      const dark = await browser.newPage();
      await dark.addInitScript(() => document.documentElement.classList.add("dark"));
      await dark.goto(server.url);
      await dark.evaluate(() => document.documentElement.classList.add("dark"));
      await expect(dark.locator("[data-app-root='true']")).toBeVisible();
      await expect(dark.locator("html")).toHaveClass(/dark/);
      // A fresh browser has no remembered thread: open the session from the sidebar, which loads
      // its history from omp.
      await dark.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
      await expect(
        dark
          .locator('[data-slot="u1-message-row"][data-role="user"]')
          .filter({ hasText: promptText }),
      ).toBeVisible();
      await expect(dark.locator('[data-testid^="tool-card-"]').first()).toBeVisible();
      await waitForFiniteAnimations(dark);
      await dark.screenshot({ path: join(screenshots, "app-root-dark.png"), fullPage: true });
      await dark.setViewportSize({ width: 390, height: 844 });
      await waitForFiniteAnimations(dark);
      await dark.screenshot({ path: join(screenshots, "app-root-narrow.png"), fullPage: true });
      await dark.close();
      await page.close();
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await stopChild(server?.process);
      if (provider?.process.stdin) provider.process.stdin.end();
      await stopChild(provider?.process);
      await rm(root, { recursive: true, force: true });
    }
  },
);
