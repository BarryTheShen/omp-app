import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  type RealApp,
  realTest,
  screenshots,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/** The sentence the composer shows for `/clear`, which omp runs only in its terminal. */
const CLEAR_REFUSAL =
  "/clear only runs in omp's terminal, so nothing was sent. Use New chat instead.";
/** The sentence for `/loop`, which has no app equivalent. */
const LOOP_REFUSAL = "/loop only runs in omp's terminal, so nothing was sent.";

/** The reason the composer shows for a send it did not make. */
function composerError(page: Page): Locator {
  return page.locator('[data-composer-error="true"]');
}

/** Every session file omp wrote in this run: a message that reached omp would be in one of them. */
async function sessionFilesText(realApp: RealApp): Promise<string> {
  const sessions = join(realApp.agentDir, "sessions");
  if (!existsSync(sessions)) return "";
  const names = (await readdir(sessions, { recursive: true })).filter((name) =>
    name.endsWith(".jsonl"),
  );
  return (await Promise.all(names.map((name) => readFile(join(sessions, name), "utf8")))).join(
    "\n",
  );
}

/**
 * Types a message, then presses Enter until `answer` shows. An Enter pressed while the slash list is loading is dropped
 * for text that is no command, and the list can load again after it first answers, so one Enter is not enough. A dropped
 * Enter sends nothing, and a send that worked clears the composer, so pressing again is safe.
 */
async function typeCommand(
  page: Page,
  composer: Locator,
  text: string,
  answer: Locator,
): Promise<void> {
  await composer.fill(text);
  await expect(page.getByText("No matching commands.")).toBeVisible({ timeout: 60_000 });
  await expect(async () => {
    await composer.press("Enter");
    await expect(answer).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
}

realTest(
  "typing /clear is refused in the composer, and neither omp nor the model receives it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);

    await typeCommand(
      page,
      composer,
      "/clear",
      composerError(page).filter({ hasText: CLEAR_REFUSAL }),
    );
    await expect(composerError(page)).toHaveText(CLEAR_REFUSAL, { timeout: 60_000 });
    // The text stays in the composer; the fake model never answered it and no session file holds it.
    await expect(composer).toHaveValue("/clear");
    await expect(page.getByText("pong")).toHaveCount(0);
    expect(await sessionFilesText(realApp)).not.toContain("/clear");
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1271-clear-light.png"), fullPage: true });

    // A command with no app equivalent says so in the same plain way.
    await typeCommand(
      page,
      composer,
      "/loop",
      composerError(page).filter({ hasText: LOOP_REFUSAL }),
    );
    await expect(composerError(page)).toHaveText(LOOP_REFUSAL);
    await expect(page.getByText("pong")).toHaveCount(0);
    expect(await sessionFilesText(realApp)).not.toContain("/loop");

    // A path is not a command, so it still reaches the model: the fake model answers "pong".
    await typeCommand(page, composer, "/etc/hosts", page.getByText("pong").first());
    await expect(page.getByText("pong").first()).toBeVisible({ timeout: 60_000 });
  },
);

realTest(
  "the /clear refusal reads in dark mode and stays inside a 390 px screen",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
    await page.reload();
    const composer = await startChat(page);

    await typeCommand(
      page,
      composer,
      "/clear",
      composerError(page).filter({ hasText: CLEAR_REFUSAL }),
    );
    await expect(composerError(page)).toHaveText(CLEAR_REFUSAL, { timeout: 60_000 });
    await expect(page.locator("html")).toHaveClass(/dark/);
    // The sentence is painted with the app's own colour, not the browser's default text colour.
    expect(
      await composerError(page).evaluate((element) => getComputedStyle(element).color),
    ).not.toBe("rgb(0, 0, 0)");

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    const box = await composerError(page).boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: join(screenshots, "fix-1271-clear-dark-narrow.png"),
      fullPage: true,
    });
  },
);
