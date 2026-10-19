import { join } from "node:path";
import { expect, realTest, screenshots, sendPrompt, startChat } from "./real-omp";

/**
 * The composer toolbar's model button opens a dialog with the model list and the thinking level. On real omp:
 * the thinking list must open (it is a popup outside the dialog's markup, and the dialog once pulled
 * focus back out of it, closing it at once), a change must reach omp, and the toolbar must show what
 * omp now uses without waiting for the next message, and again after a reload.
 */
realTest(
  "the model and the thinking level can be changed from the composer toolbar",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(150_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });

    // A CSS locator: while the dialog is open, its trigger is hidden from role queries.
    const pill = page.locator('[data-layout-area="composerToolbar"] button[aria-label^="Model:"]');
    await expect(pill).toHaveAttribute("aria-label", "Model: Fake Model. Change model or thinking");
    await expect(pill).toContainText("high");

    // Thinking level: the list opens, stays open, and the choice reaches omp and the toolbar.
    await pill.click();
    const dialog = page.getByRole("dialog", { name: "Model and thinking" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^Thinking: High/ }).click();
    const levels = page.getByRole("listbox", { name: "Thinking levels" });
    await expect(levels).toBeVisible();
    // Keyboard focus is in the list (the dialog's focus trap once pulled it back out), and stays
    // there, so the options can be reached and chosen from the keyboard.
    const focusInList = () =>
      page.evaluate(
        () =>
          document.activeElement?.closest('[role="listbox"][aria-label="Thinking levels"]') !==
          null,
      );
    await expect.poll(focusInList).toBe(true);
    await page.waitForTimeout(500);
    expect(await focusInList()).toBe(true);
    await page.screenshot({ path: join(screenshots, "model-thinking-switch", "levels-open.png") });
    await levels.getByRole("option", { name: "Low" }).click();
    await expect(dialog.getByText("Current: Low")).toBeVisible({ timeout: 20_000 });
    await expect(pill).toContainText("low", { timeout: 20_000 });

    // Model: the pick reaches omp and the composer toolbar names it at once.
    await dialog.getByRole("button", { name: /fake\/claude-fable-5 ·/ }).click();
    await expect(dialog.getByText("Active: fake/claude-fable-5")).toBeVisible({ timeout: 20_000 });
    await expect(pill).toHaveAttribute(
      "aria-label",
      "Model: Claude Fable 5. Change model or thinking",
      { timeout: 20_000 },
    );
    await page.screenshot({ path: join(screenshots, "model-thinking-switch", "model-picked.png") });
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(pill).toHaveAttribute(
      "aria-label",
      "Model: Claude Fable 5. Change model or thinking",
    );

    // The next message runs on the new model, and a reload still shows both choices.
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toHaveCount(2, { timeout: 60_000 });
    await page.reload();
    const again = page.locator('[data-layout-area="composerToolbar"] button[aria-label^="Model:"]');
    await expect(again).toHaveAttribute(
      "aria-label",
      "Model: Claude Fable 5. Change model or thinking",
      { timeout: 30_000 },
    );
    await expect(again).toContainText("low");
    expect(realApp.problems).toEqual([]);
  },
);
