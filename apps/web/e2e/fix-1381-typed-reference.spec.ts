import { expect, realTest, startChat } from "./real-omp";

/*
 * Issue 1381: choosing a GitHub reference typed as `pr #12` or `issue #5` leaves the typed word in front of the link,
 * so the message reads `see pr pr://12 `. The row the list offers replaces the typed word too, so the message reads
 * `see pr://12 `. The rows are omp's, built from the number here: no GitHub CLI is asked (issue 2529).
 */

realTest(
  "a GitHub reference typed as 'pr #12' or 'issue #5' is replaced by its link, the typed word included (issue 1381)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);

    await composer.fill("see pr #12");
    await expect(page.getByText("PR #12", { exact: true })).toBeVisible({ timeout: 60_000 });
    await page.getByText("PR #12", { exact: true }).click();
    await expect(composer).toHaveValue("see pr://12 ");

    await composer.fill("see pr://12 and issue #5");
    await expect(page.getByText("Issue #5", { exact: true })).toBeVisible({ timeout: 60_000 });
    await page.getByText("Issue #5", { exact: true }).click();
    await expect(composer).toHaveValue("see pr://12 and issue://5 ");
    expect(realApp.problems).toEqual([]);
  },
);
