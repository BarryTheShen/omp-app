import { mkdir } from "node:fs/promises";

import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, sendPrompt, startChat } from "./real-omp";

const DESKTOP = { width: 1280, height: 1000 } as const;

async function assertThemeTokens(page: Page) {
  await page.locator("html").evaluate((element) => {
    if (getComputedStyle(element).getPropertyValue("--background").trim() === "") {
      throw new Error("theme tokens did not load");
    }
  });
}

realTest(
  "a completed background bash notice shows its typed finished line, not omp's message for the model",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize(DESKTOP);
    const composer = await startChat(page);
    await sendPrompt(composer, "run_quick_background");
    const bashCard = page
      .getByTestId("u3-bash-card")
      .filter({ hasText: "sleep 2; echo quick-done" });
    await expect(bashCard).toBeVisible({ timeout: 120_000 });
    const notice = page.locator('[data-custom-type="async-result"]').first();
    await expect(notice).toBeVisible({ timeout: 120_000 });

    await expect(notice).toContainText("sleep 2; echo quick-done finished · 2 seconds.");
    const details = notice.locator('[data-slot="u1-custom-note-details"]');
    await expect(details).not.toHaveAttribute("open", "");
    await expect(details.locator('[data-slot="u1-custom-note-body"]')).toBeHidden();
    await expect(notice).toContainText("Full message");
    await mkdir(join(screenshots, "issue-1488"), { recursive: true });
    await assertThemeTokens(page);
    await page.getByRole("region", { name: "Conversation transcript" }).screenshot({
      path: join(screenshots, "issue-1488", "notice-light.png"),
    });
    await details.getByText("Full message", { exact: true }).click();
    const lightBody = details.locator('[data-slot="u1-custom-note-body"]');
    await expect(lightBody).toBeVisible();
    await expect(lightBody).toContainText("quick-done");
    await expect(lightBody).toContainText("Wall time: 2");
    await page.getByRole("region", { name: "Conversation transcript" }).screenshot({
      path: join(screenshots, "issue-1488", "notice-light-open.png"),
    });
    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
    await page.reload();
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    const reopenedNotice = page.locator('[data-custom-type="async-result"]').first();
    await expect(reopenedNotice).toBeVisible({ timeout: 120_000 });

    const reopenedDetails = reopenedNotice.locator('[data-slot="u1-custom-note-details"]');
    await expect(reopenedNotice).toContainText("sleep 2; echo quick-done finished · 2 seconds.");
    await expect(reopenedDetails.locator('[data-slot="u1-custom-note-body"]')).toBeHidden();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await assertThemeTokens(page);
    await page.getByRole("region", { name: "Conversation transcript" }).screenshot({
      path: join(screenshots, "issue-1488", "notice-dark.png"),
    });
    await reopenedDetails.getByText("Full message", { exact: true }).click();
    const darkBody = reopenedDetails.locator('[data-slot="u1-custom-note-body"]');
    await expect(darkBody).toBeVisible();
    await expect(darkBody).toContainText("quick-done");
    await expect(darkBody).toContainText("Wall time: 2");
    await page.getByRole("region", { name: "Conversation transcript" }).screenshot({
      path: join(screenshots, "issue-1488", "notice-dark-open.png"),
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(reopenedDetails).toHaveAttribute("open", "");
    await assertThemeTokens(page);
    await page.getByRole("region", { name: "Conversation transcript" }).screenshot({
      path: join(screenshots, "issue-1488", "notice-narrow-open.png"),
    });
    await reopenedDetails.getByText("Full message", { exact: true }).click();
    await expect(reopenedDetails).not.toHaveAttribute("open", "");
    await page.getByRole("region", { name: "Conversation transcript" }).screenshot({
      path: join(screenshots, "issue-1488", "notice-narrow.png"),
    });
    expect(realApp.problems).toEqual([]);
  },
);
