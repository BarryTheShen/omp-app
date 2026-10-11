/// <reference types="node" />
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * The fake model answers `long_probe_child` with a bash call that sleeps 60 s. While it runs, the card's header reads
 * Running (#873), and the card must say nothing about waiting: the area for output says that no output has come yet.
 */
const BASH = "tool-card-call_bash";
const EMPTY = '[data-slot="u3-bash-empty"]';

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

realTest.setTimeout(420_000);

realTest(
  "a bash command that is running reads Running, and its card never says Waiting",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    // The chat has loaded (the thread shows its empty state, not "Loading conversation"): a prompt typed while it
    // loads is lost when the draft loads.
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await sendPrompt(composer, "long_probe_child running label");

    const bash = page.getByTestId(BASH);
    await expect(bash).toHaveAttribute("data-phase", "running", { timeout: 60_000 });
    await expect(bash).toContainText("Running");
    await expect(bash.locator(EMPTY)).toContainText("No output yet.");
    await expect(bash).not.toContainText("Waiting");

    await bash.scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "fix-918-bash-running-light.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "fix-918-bash-running-dark.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await bash.scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "fix-918-bash-running-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
