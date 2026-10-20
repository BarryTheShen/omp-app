import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  openToolCard,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue 1425. A subagent's row in the Tasks view (the wait card) showed omp's own result block as its result text:
 * `<task-result ...>` with its `<meta>`, `<abort-reason>`, `<error>` and `<output>` tags, then omp's words for the model.
 * The row now shows the reason the run failed, when it failed after it produced text, and the text it produced.
 * `spawn_steerable_subagent` starts a worker (SteerProbe) that waits for a steer; `wait_for_jobs` lists it with its Stop
 * control, and Stop ends it. `spawn_stream_failing_subagent` starts a worker (StreamProbe) that streams one line of text
 * and then fails, so its row has both a reason and a text.
 */

realTest.setTimeout(420_000);

/** The Tasks row for one worker, by its name. */
function rowOf(wait: Locator, worker: string): Locator {
  return wait.locator("li").filter({ hasText: worker });
}

/** One capture of the row in the given theme, after the page's transitions finish. The theme is light after it. */
async function capture(page: Page, row: Locator, name: string, dark: boolean): Promise<void> {
  await page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);
  await waitForFiniteAnimations(page);
  // Centred, so the chat's bottom bar cannot cover the row's text lines in the capture.
  await row.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await row.screenshot({ path: join(screenshots, name) });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

realTest(
  "a stopped subagent's row in the Tasks view shows its output, not omp's result block or its words for the model",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 1000 });
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_steerable_subagent");
    await expect(page.getByTestId("t5-task-card")).toBeVisible({ timeout: 120_000 });
    // The spawn's turn settles before the next prompt: a prompt typed while omp still works stays in the composer.
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    await sendPrompt(composer, "wait_for_jobs");

    const wait = page.getByTestId("t5-wait-card");
    await expect(wait).toBeVisible({ timeout: 120_000 });
    await openToolCard(wait);
    const row = rowOf(wait, "SteerProbe");
    await expect(row).toBeVisible({ timeout: 120_000 });
    await row.getByRole("button", { name: /^Stop background job / }).click();
    await expect(row).toContainText("The background command stopped before its result came back.", {
      timeout: 240_000,
    });

    await expect(row).toContainText("Cancelled");
    await expect(row).toContainText("(no output)");
    for (const words of ["<task-result", "<abort-reason>", "<output>", "history://"]) {
      await expect(row).not.toContainText(words);
    }
    await capture(page, row, "fix-1425-stopped-light.png", false);
    await capture(page, row, "fix-1425-stopped-dark.png", true);
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, row, "fix-1425-stopped-narrow.png", false);

    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a subagent that failed after it streamed text shows why it failed, then the text it produced",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 1000 });
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_stream_failing_subagent");
    await expect(page.getByTestId("t5-task-card")).toBeVisible({ timeout: 120_000 });
    // The spawn's turn settles before the next prompt: a prompt typed while omp still works stays in the composer.
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    await sendPrompt(composer, "wait_for_jobs");

    const wait = page.getByTestId("t5-wait-card");
    await expect(wait).toBeVisible({ timeout: 120_000 });
    await openToolCard(wait);
    const row = rowOf(wait, "StreamProbe");
    await expect(row).toContainText("Failed", { timeout: 180_000 });
    await expect(row).toContainText("fake stream failure after the partial answer");
    await expect(row).toContainText("Partial answer before the stream failed.");
    for (const words of ["<task-result", "<error>", "<output>", "<abort-reason>", "history://"]) {
      await expect(row).not.toContainText(words);
    }
    await capture(page, row, "fix-1425-failed-light.png", false);
    await capture(page, row, "fix-1425-failed-dark.png", true);
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, row, "fix-1425-failed-narrow.png", false);

    expect(realApp.problems).toEqual([]);
  },
);
