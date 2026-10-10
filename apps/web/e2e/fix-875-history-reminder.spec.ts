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

/**
 * Issue #875. omp writes its todo reminder into the session as a developer message wrapped in
 * `<system-reminder>` tags. The conversation history drew that markup under "Instruction". It must
 * show the words, with no tag names. This drives the app's own history panel after a real omp turn
 * that leaves two todos open, so omp writes its reminder.
 */
realTest(
  "real omp: the conversation history shows the todo reminder in plain words",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "make_todos");
    // The thread shows the reminder's closing lines as a grey note once omp has written it.
    await expect(
      page.getByText("Please continue working on these tasks or mark them complete if finished."),
    ).toBeVisible({ timeout: 120_000 });

    await page.keyboard.press("Control+Shift+H");
    await expect(page.getByRole("tab", { name: "Conversation history" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const reminder = page.getByRole("treeitem", { name: /^Instruction,/ });
    await expect(reminder).toHaveCount(1, { timeout: 60_000 });
    await expect(reminder).toContainText("Please continue working on these tasks");
    await expect(reminder).not.toContainText("system-reminder");

    await reminder.click();
    const preview = page.getByRole("region", { name: "Message preview" });
    await expect(preview).toContainText("(Reminder 1/3)");
    await expect(preview).not.toContainText("system-reminder");
    await expect(page.getByText("system-reminder")).toHaveCount(0);

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-875-history-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-875-history-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    // The narrow layout closes the panels; the chord reopens the history at this width.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press("Control+Shift+H");
    await expect(reminder).toBeVisible();
    await expect(preview).toContainText("(Reminder 1/3)");
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-875-history-390.png") });
  },
);
