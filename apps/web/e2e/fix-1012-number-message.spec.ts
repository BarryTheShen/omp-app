import { join } from "node:path";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

realTest.setTimeout(180_000);

/**
 * Issue #1012. A number setting with no upper limit said "Enter a number from 0 to
 * 1.7976931348623157e+308." (the largest JavaScript number, written as code). The Loop Condition
 * Timeout now says "Enter a number, 0 or more.", for -1 and for an emptied field, and the number never
 * shows on screen.
 */
const RULE = "Enter a number, 0 or more.";

realTest(
  "Loop Condition Timeout says -1 and an empty field need a number 0 or more, in plain words",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Interaction", exact: true }).click();
    await dialog.getByRole("option", { name: "Input", exact: true }).click();
    const timeout = dialog.getByRole("spinbutton", { name: "Loop Condition Timeout (ms)" });
    await expect(timeout).toBeVisible({ timeout: 30_000 });

    await timeout.fill("-1");
    await expect(dialog.getByText(RULE)).toBeVisible();
    await expect(timeout).toHaveValue("-1");
    await timeout.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: join(screenshots, "fix-1012-loop-timeout-light.png") });

    await timeout.fill("");
    await expect(dialog.getByText(RULE)).toBeVisible();

    await page.emulateMedia({ colorScheme: "dark" });
    await timeout.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: join(screenshots, "fix-1012-loop-timeout-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });
    await timeout.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect(dialog.getByText(RULE)).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1012-loop-timeout-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 900 });

    await expect(dialog.getByText("1.7976931348623157")).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
