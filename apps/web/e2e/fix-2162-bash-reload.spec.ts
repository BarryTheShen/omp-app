import { expect, realTest, startChat } from "./real-omp";

/*
 * Issue 2162, N1: a reload while a first-line `!` command runs. The page that sent the command shows it as running; a page
 * reopened by a reload shows the same running row; the output appears when the command ends, with no second reload.
 */

realTest.setTimeout(300_000);

realTest(
  "a `!` command shows as running after a reload, and its output appears when it ends, with no second reload",
  async ({ realApp }, testInfo) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.fill("!sleep 12; echo b1-late");
    await composer.press("Enter");

    const row = page.locator('[data-slot="u1-execution-row"]');
    await expect(row).toContainText("Running");
    await expect(row).toContainText("sleep 12; echo b1-late");
    await expect(page.getByRole("button", { name: "Stop command" })).toBeVisible();

    await page.waitForTimeout(2500);
    await page.reload();
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Running");
    await expect(row).toContainText("sleep 12; echo b1-late");
    await expect(page.getByRole("button", { name: "Stop command" })).toBeVisible();
    await row.screenshot({ path: testInfo.outputPath("fix-2162-running-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.waitForTimeout(400);
    await row.screenshot({ path: testInfo.outputPath("fix-2162-running-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    await row.screenshot({ path: testInfo.outputPath("fix-2162-running-390.png") });
    await page.setViewportSize({ width: 1280, height: 800 });

    await expect(page.getByTestId("u1-execution-output")).toContainText("b1-late", {
      timeout: 30_000,
    });
    await expect(row).toHaveCount(1);
    await expect(row).not.toContainText("Running");
    await expect(page.getByRole("button", { name: "Stop command" })).toHaveCount(0);
  },
);

realTest(
  "Stop command ends a running `!` command: the row reads Cancelled, with omp's cancellation note and no echo output",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.fill("!sleep 12; echo b1-late");
    await composer.press("Enter");

    const row = page.locator('[data-slot="u1-execution-row"]');
    await expect(row).toContainText("Running");
    await page.getByRole("button", { name: "Stop command" }).click();
    await expect(row).toContainText("Cancelled", { timeout: 15_000 });
    await expect(row).not.toContainText("Running");
    await expect(page.getByTestId("u1-execution-output")).toContainText("[Command cancelled]");
    await expect(page.getByTestId("u1-execution-output")).not.toContainText("b1-late");
  },
);
