import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1368. A chat's slash commands and its turn watch share one event stream. Leaving the chat's slash commands
 * ended that stream for the turn watch as well, so the turn watch never learned that a chat left mid-turn had ended,
 * and the chat's omp was never let go. Now each holder lets go of its own part: when the turn ends the chat is let go,
 * and only the chat on screen keeps its omp.
 */

realTest.setTimeout(300_000);
/** An unwatched chat's omp stops after this idle time once omp is settled (as in process-release.spec.ts). */
realTest.use({ idleCloseMs: 1_500 });

const PROMPT = "stream_long_code please";
/** The last line of the block the fake model streams for `stream_long_code`: it is on disk once the reply is written. */
const LAST_LINE = "export const value47";
/** The spinner of a row in the session list's Running group. */
const RUNNING = '[data-slot="r1-session-running"]';

function sessionFilesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...sessionFilesUnder(path));
    else if (name.endsWith(".jsonl")) found.push(path);
  }
  return found;
}

/** Whether omp has written the end of the reply: the turn is over. */
function replyWritten(agentDir: string): boolean {
  return sessionFilesUnder(join(agentDir, "sessions")).some((file) =>
    readFileSync(file, "utf8").includes(LAST_LINE),
  );
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

realTest(
  "a chat left mid-turn is let go when its turn ends, and its row returns to idle",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    const composer = await startChat(page);
    // Typing / loads omp's command list, which joins this chat's event stream.
    await composer.fill("/us");
    await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible({
      timeout: 30_000,
    });
    await composer.fill(PROMPT);
    await composer.press("Enter");
    // The turn is running, and the person leaves the chat before it ends.
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 60_000,
    });
    await startChat(page);
    await expect(page.locator(RUNNING)).toHaveCount(1, { timeout: 15_000 });

    // omp finishes the reply while the person is on the other chat.
    await expect.poll(() => replyWritten(realApp.agentDir), { timeout: 120_000 }).toBe(true);
    await expect(page.locator(RUNNING)).toHaveCount(0, { timeout: 20_000 });
    // The chat left mid-turn is let go, so only the chat on screen keeps an omp process.
    await expect.poll(() => realApp.ompProcesses().length, { timeout: 30_000 }).toBe(1);

    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "shared-stream-listeners-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "shared-stream-listeners-dark.png") });
    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "shared-stream-listeners-narrow.png") });
  },
);
