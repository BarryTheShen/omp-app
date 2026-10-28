import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * D4.6. Typed `/copy` in the composer is the app's own command: it opens the conversation copy picker over the open
 * chat, the same picker the palette's "Copy from this chat" opens. Before the composition, omp's terminal-only `/copy`
 * answered it instead.
 */

/** The fake model answers a prompt with no keyword in it with this word. */
const ANSWER = "pong";

/** The conversation copy picker, which lists the chat's messages and code to copy. */
function picker(page: Page): Locator {
  return page.getByRole("listbox", { name: "Copy from this chat" });
}

realTest(
  "typed /copy opens the conversation copy picker over this chat",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "Hello for the copy check");
    await expect(page.getByText(ANSWER, { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    // Copy offers saved messages only; a saved message shows its actions (Edit), as a person sees.
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible({
      timeout: 60_000,
    });

    await sendPrompt(composer, "/copy");
    await expect(picker(page)).toBeVisible({ timeout: 30_000 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "d4-6-copy-slash-light.png"), fullPage: true });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "d4-6-copy-slash-dark.png"), fullPage: true });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "d4-6-copy-slash-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
