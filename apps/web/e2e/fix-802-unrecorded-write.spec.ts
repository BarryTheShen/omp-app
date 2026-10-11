/// <reference types="node" />
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #802. A call with no recorded result, in a finished transcript, reads "No result recorded", never as a
 * success. The chat is seeded with omp's raw session entries: an assistant message whose write call has no result,
 * the transcript a cut-off worker holds. (A real worker cut off by a yield is answered by omp with an aborted error,
 * so the unanswered state is seeded here; the card and its state are the same.)
 */

const WRITE_ENTRIES = [
  {
    type: "message",
    message: { role: "user", content: "write the notes", timestamp: 1 },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-unanswered-write",
          name: "write",
          arguments: { path: "notes.txt", content: "a note that was never written" },
        },
      ],
      api: "openai-completions",
      provider: "fake",
      model: "fake-model",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    },
  },
];

const DESKTOP = { width: 1280, height: 900 } as const;
const NARROW = { width: 390, height: 844 } as const;

realTest.use({ seedEntries: { entries: WRITE_ENTRIES } });
realTest.setTimeout(300_000);

/** The app's styles are loaded: the shell's background is the theme's background token, not the browser default. */
async function expectStyledShell(page: Page): Promise<void> {
  const colors = await page.locator("[data-shell-layout]").evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--background)";
    document.body.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual: getComputedStyle(element).backgroundColor, token };
  });
  expect(colors.token).not.toBe("");
  expect(colors.actual).toBe(colors.token);
}

/** The card reads No result recorded in its muted look: a Finished chip, and no success tone or word anywhere in it. */
async function expectUnrecordedCard(card: Locator): Promise<void> {
  await expect(card.getByText("No result recorded").first()).toBeVisible();
  await expect(card.getByTestId("tool-state-chip-unrecorded")).toHaveText("Finished");
  await expect(card.getByText("Created", { exact: true })).toHaveCount(0);
  await expect(card.getByText("Complete", { exact: true })).toHaveCount(0);
  expect(await card.locator('[class*="success"]').count()).toBe(0);
}

async function openSeededChat(page: Page): Promise<Locator> {
  await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
  const card = page.getByTestId("t1-write-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  return card;
}

realTest("an unanswered write reads No result recorded in the light theme", async ({ realApp }) => {
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
  });
  await page.setViewportSize(DESKTOP);
  const card = await openSeededChat(page);
  await expectUnrecordedCard(card);
  await expectStyledShell(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-802-unanswered-write-light.png") });
  expect(realApp.problems).toEqual([]);
});

realTest("an unanswered write reads No result recorded in the dark theme", async ({ realApp }) => {
  // The stored theme is applied before the first paint, so the page renders dark from its first frame.
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await page.setViewportSize(DESKTOP);
  const card = await openSeededChat(page);
  expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
  await expectUnrecordedCard(card);
  await expectStyledShell(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-802-unanswered-write-dark.png") });
  expect(realApp.problems).toEqual([]);
});

realTest("an unanswered write reads No result recorded at 390 px", async ({ realApp }) => {
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
  });
  await page.setViewportSize(DESKTOP);
  const card = await openSeededChat(page);
  await page.setViewportSize(NARROW);
  await expectUnrecordedCard(card);
  await expectStyledShell(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-802-unanswered-write-narrow.png") });
  expect(realApp.problems).toEqual([]);
});
