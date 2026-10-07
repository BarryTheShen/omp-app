import { expect, realTest, sendPrompt, startChat } from "./real-omp";

/**
 * Issue #685, the live half: a turn that runs sixty steps while the page watches. The fake model's
 * `long_loop` keyword makes omp run sixty bash steps in one turn and then answer. The page must keep
 * only the latest twenty steps mounted and fold the rest as they arrive.
 */
realTest(
  "a turn that runs sixty steps live folds its earlier steps as they arrive and keeps the latest twenty",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await sendPrompt(composer, "Please run the long_loop job.");

    const cards = page.locator('[data-slot="u3-bash-card"]');
    // Sixty steps and the answer are 61 parts: the first 41 fold away.
    await expect(page.getByText("loop finished")).toBeVisible({ timeout: 120_000 });
    const fold = page.getByRole("button", { name: /earlier steps/ });
    await expect(fold).toHaveText("41 earlier steps");
    await expect(cards).toHaveCount(19);
    await expect(page.getByText("echo loop-59", { exact: true })).toBeVisible();
    await expect(page.getByText("echo loop-41", { exact: true })).toBeVisible();
    await expect(page.getByText("echo loop-40", { exact: true })).toHaveCount(0);

    // Every folded step is still there on request, in order.
    await fold.click();
    await expect(cards).toHaveCount(19 + 41);
    await expect(page.getByText("echo loop-0", { exact: true })).toBeVisible();
  },
);
