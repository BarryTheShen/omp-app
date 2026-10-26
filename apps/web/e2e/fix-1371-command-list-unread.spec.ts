import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  narrowTo,
  realTest,
  screenshots,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * #1371: omp's command list cannot be read in these runs. Every chat runs through a shell wrapper around the proxy
 * beside this spec: the proxy answers `get_available_commands` with an error and passes every other line to the chat.
 */
const PROXY = resolve(process.cwd(), "e2e/fix-1371-omp-without-command-list.ts");
const wrapperDir = resolve(process.cwd(), "../../.data/fix-1371-command-list");
mkdirSync(wrapperDir, { recursive: true });
const wrapper = join(wrapperDir, "omp-without-command-list.sh");
writeFileSync(wrapper, `#!/bin/sh\nexec bun "${PROXY}" "$@"\n`);
chmodSync(wrapper, 0o755);
realTest.use({ chatWrapper: wrapper });

const HELD =
  "/compact wasn't sent because omp's command list could not be read. omp could not list its commands.";

/** The reason the composer shows for a send it did not make. */
function composerError(page: Page): Locator {
  return page.locator('[data-composer-error="true"]');
}

/**
 * Types a command, then waits until the list shows that it could not be read, and presses Enter until the held reason
 * shows. An Enter pressed while the list loads is dropped for text that is no command, and the list can load again
 * after its first answer, so one Enter is not enough. A dropped Enter stores nothing, and a held send keeps the text,
 * so pressing again is safe.
 */
async function typeCommand(page: Page, composer: Locator, text: string): Promise<void> {
  await composer.fill(text);
  await expect(page.getByText("omp could not list its commands.", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(async () => {
    await composer.press("Enter");
    await expect(composerError(page)).toHaveText(HELD, { timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
}

realTest(
  "a typed command is held in the composer with the reason, and omp never receives it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);

    await typeCommand(page, composer, "/compact");
    await expect(composerError(page)).toHaveText(HELD, { timeout: 60_000 });
    // The text stays in the composer, and the fake model never answered it.
    await expect(composer).toHaveValue("/compact");
    await expect(page.getByText("pong")).toHaveCount(0);
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 60_000 });
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1371-held-light.png"), fullPage: true });
  },
);

realTest(
  "text that is not a command still reaches the model while the list is unreadable",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);

    // The fake model answers "pong" to any text that is not a command, even while omp's command list cannot be read.
    await composer.fill("/");
    await expect(page.getByText("omp could not list its commands.", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await composer.fill("hello there");
    await composer.press("Enter");
    await expect(page.getByText("pong").first()).toBeVisible({ timeout: 60_000 });
  },
);

realTest(
  "the held reason reads in dark mode and stays inside a 390 px screen",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
    await page.reload();
    const composer = await startChat(page);

    await typeCommand(page, composer, "/compact");
    await expect(composerError(page)).toHaveText(HELD, { timeout: 60_000 });
    await expect(page.locator("html")).toHaveClass(/dark/);
    // The reason is painted with the app's own colour, not the browser's default text colour.
    expect(
      await composerError(page).evaluate((element) => getComputedStyle(element).color),
    ).not.toBe("rgb(0, 0, 0)");

    await narrowTo(page);
    const box = await composerError(page).boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: join(screenshots, "fix-1371-held-dark-narrow.png"),
      fullPage: true,
    });
  },
);
