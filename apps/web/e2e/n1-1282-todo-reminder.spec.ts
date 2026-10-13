import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

const NARROW = { width: 390, height: 844 } as const;
/** The fake model answers this keyword with a two-item todo list that stays open, so omp's turn stops with it. */
const TODO_PROMPT = "Please make_todos for the release.";
/** omp reminds the model with attempt 1 of 3 (its `maxAttempts`), in plain words. */
const HEADING = "Unfinished todos (attempt 1 of 3)";
const NOTICES = "Notices in this conversation";

/**
 * Issue #1282. A turn that stops with unfinished todos makes omp send `todo_reminder`; the app writes
 * the reminder into the chat's transcript, after the messages, with its unfinished items and the attempt.
 */
realTest(
  "real omp: a turn that ends with unfinished todos shows the reminder with its items in the transcript",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, TODO_PROMPT);

    const notices = page.getByRole("region", { name: NOTICES });
    await expect(notices.getByText(HEADING)).toBeVisible({ timeout: 120_000 });
    await expect(notices).toContainText("• Write the thing");
    await expect(notices).toContainText("• Test the thing");
    // The reminder is part of the transcript, not a floating toast.
    await expect(
      page.locator('[data-slot="u1-thread-messages"] [data-slot="n1-transcript-notices"]'),
    ).toHaveCount(1);

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "n1-1282-todo-reminder-light.png") });
    await page.setViewportSize(NARROW);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "n1-1282-todo-reminder-390.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("the todo reminder reads in dark mode", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(300_000);
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  const composer = await startChat(page);
  await sendPrompt(composer, TODO_PROMPT);

  const notices = page.getByRole("region", { name: NOTICES });
  await expect(notices.getByText(HEADING)).toBeVisible({ timeout: 120_000 });
  await expect(notices).toContainText("• Test the thing");

  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "n1-1282-todo-reminder-dark.png") });
  expect(realApp.problems).toEqual([]);
});
