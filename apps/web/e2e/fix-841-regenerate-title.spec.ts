import { mkdir } from "node:fs/promises";
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
 * Issue #841. Regenerate asks the answer again on a new chat, which omp makes as a branch of the chat it came
 * from. This is the real app: a chat, its answer regenerated, and the session list must tell the two chats
 * apart. No name is written into the branch's file: omp gives it its source's name, and the branch's own line
 * says it is a branch and when it was made. The original keeps its own answer.
 */

/** A `count_reply <word>` answer reads `count-<n> <word>`; the counter rises across the fake server. */
function counterOf(text: string | null): number {
  const match = /^count-(\d+) /.exec(text ?? "");
  if (match?.[1] === undefined) throw new Error(`Not a counted answer: ${text ?? "(none)"}`);
  return Number(match[1]);
}

function answerTo(page: Page, word: string) {
  return page.getByText(new RegExp(`^count-\\d+ ${word}$`));
}

function sessionList(page: Page) {
  return page.getByRole("listbox", { name: "Session list" });
}

/** Regenerates the answer that read `count-<firstCount> <word>` and waits until the answer on screen is the new one. */
async function regenerate(page: Page, word: string, firstCount: number): Promise<void> {
  const reply = page.locator('[data-slot="u1-message-row"][data-role="assistant"]', {
    hasText: `count-${firstCount} ${word}`,
  });
  await reply.hover();
  await reply.getByRole("button", { name: "Regenerate response" }).click();
  await expect
    .poll(async () => counterOf(await answerTo(page, word).textContent()), { timeout: 60_000 })
    .toBeGreaterThan(firstCount);
}

/** Styles have loaded before a capture: the page background is a token colour, not the browser default. */
async function expectStylesLoaded(page: Page): Promise<void> {
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(
    "rgba(0, 0, 0, 0)",
  );
}

/**
 * Waits until the sessions drawer has finished opening: it takes input once its `inert` is gone, and its slide starts a
 * frame after that, so two frames pass before the finite animations are awaited. Measuring before then reads the drawer
 * mid-slide (issue 1519).
 */
async function waitForSessionsDrawerOpen(page: Page): Promise<void> {
  await expect(page.locator("#shell-sessions-sidebar")).not.toHaveAttribute("inert", "");
  await page.evaluate(async () => {
    const nextFrame = (): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      requestAnimationFrame(() => resolve());
      return promise;
    };
    await nextFrame();
    await nextFrame();
  });
  await waitForFiniteAnimations(page);
}

realTest(
  "a regenerated answer lists as a branch of its chat, with its own line, and the two rows read apart",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);

    await sendPrompt(composer, "count_reply alpha");
    const firstAnswer = answerTo(page, "alpha");
    await expect(firstAnswer).toBeVisible({ timeout: 60_000 });
    const firstCount = counterOf(await firstAnswer.textContent());
    await regenerate(page, "alpha", firstCount);

    // The list holds two chats with the same title: the branch, marked as a branch with the time it was made,
    // and the original, which has no such line.
    const list = sessionList(page);
    const branch = list.getByRole("option").filter({ hasText: "Branch made" });
    const original = list
      .getByRole("option", { name: /count_reply alpha/ })
      .filter({ hasNotText: "Branch made" });
    await expect(branch).toHaveCount(1);
    await expect(original).toHaveCount(1);
    await expect(list.getByRole("option", { name: /count_reply alpha/ })).toHaveCount(2);
    await expect(branch.getByText(/^Branch made /)).toBeVisible();
    expect(await branch.textContent()).not.toEqual(await original.textContent());

    await expectStylesLoaded(page);
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-841-sidebar-light.png") });

    // Opening the original shows its own first answer, not the regenerated one.
    await original.click();
    await expect
      .poll(async () => counterOf(await answerTo(page, "alpha").textContent()), { timeout: 30_000 })
      .toBe(firstCount);

    // Dark theme, then the narrow layout where the sidebar opens from its button.
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-841-sidebar-dark.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await expect(branch).toBeVisible();
    await expect(original).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-841-sidebar-narrow.png") });
  },
);

realTest(
  "the branch of a long-titled chat keeps its marker in view, so its row still reads apart from its source",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    // One word, so the fake model echoes all of it; the chat's name is its first prompt, which is long.
    const word = "quarterly-planning-notes-for-the-district-budget-review-and-staffing";
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);

    await sendPrompt(composer, `count_reply ${word}`);
    const firstAnswer = answerTo(page, word);
    await expect(firstAnswer).toBeVisible({ timeout: 60_000 });
    const firstCount = counterOf(await firstAnswer.textContent());
    await regenerate(page, word, firstCount);

    const list = sessionList(page);
    const branch = list.getByRole("option").filter({ hasText: "Branch made" });
    const original = list
      .getByRole("option", { name: new RegExp(word) })
      .filter({ hasNotText: "Branch made" });
    await expect(branch).toHaveCount(1);
    await expect(original).toHaveCount(1);

    // The marker is a line of its own: its whole text fits its line, so it is not cut off by the long title.
    const marker = branch.getByText(/^Branch made /);
    await expect(marker).toBeVisible();
    expect(await marker.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    expect(await branch.textContent()).not.toEqual(await original.textContent());

    await expectStylesLoaded(page);
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-841-long-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-841-long-dark.png") });

    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await expect(branch).toBeVisible();
    await expect(original).toBeVisible();
    await waitForSessionsDrawerOpen(page);
    expect(await marker.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-841-long-narrow.png") });
  },
);
