import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * #1200: the Slow mode toggle reads omp's own state (get_state) each time the dialog opens. The fake model has no
 * slow mode, so the row shows the plain reason with both buttons off, before and after the page reloads.
 */

const UNAVAILABLE = "Slow mode is not available for this model.";

async function openDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Execution modes" }).click();
  const dialog = page.getByRole("dialog", { name: "Execution modes" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The Slow mode row gives the plain reason, and both of its buttons are off and cannot be pressed. */
async function expectSlowUnavailable(dialog: Locator): Promise<void> {
  const slow = dialog.getByRole("group", { name: "Slow mode controls" });
  await expect(dialog.getByText(UNAVAILABLE, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(slow.getByRole("button", { name: "Turn on" })).toBeDisabled();
  await expect(slow.getByRole("button", { name: "Turn off" })).toBeDisabled();
}

realTest(
  "#1200 real omp: the Slow mode toggle is off and disabled with the plain reason after a reload",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await startChat(page);
    const before = await openDialog(page);
    await expectSlowUnavailable(before);
    await before.getByRole("button", { name: "Done" }).click();
    await expect(before).toBeHidden();

    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible({
      timeout: 60_000,
    });
    const after = await openDialog(page);
    await expectSlowUnavailable(after);
    await after.getByRole("group", { name: "Slow mode controls" }).scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await waitForFiniteAnimations(page);
    await after.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1200-slow-unavailable-after-reload-light.png"),
    });
    expect(realApp.problems).toEqual([]);
  },
);
