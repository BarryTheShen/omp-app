import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * A reply's links to files (#17), on real omp: a link to a file of the chat's folder opens it in the app's own viewer,
 * read over the app's connection (no address on the network), beside the chat on a computer and over the screen on a
 * phone; a link out of the folder is refused and says where it pointed; a link to a page stays a link that opens a tab.
 */
const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });

function seedFiles(folder: string): void {
  mkdirSync(join(folder, "reports"), { recursive: true });
  writeFileSync(join(folder, "reports", "report.md"), "# Lab matrix\n\nFunding per lab.\n");
  writeFileSync(join(folder, "reports", "summary.csv"), "school,pi,funding\nWashU,Huang,119300\n");
}

realTest.describe("new UI: a reply's links to files", () => {
  realTest.setTimeout(240_000);

  realTest(
    "a link to a file of the folder opens it beside the chat; one out of the folder is refused; a page stays a link",
    async ({ realApp }) => {
      seedFiles(realApp.folder);
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill("file_links");
      await box.press("Enter");
      const report = transcript(page).getByRole("link", { name: "Full report" });
      await expect(report).toBeVisible({ timeout: 90_000 });

      await report.click();
      const file = page.getByRole("region", { name: "File report.md" });
      await expect(file).toContainText("Lab matrix", { timeout: 30_000 });
      // The same link again brings the open file forward instead of a second pane.
      await report.click();
      await expect(page.getByRole("region", { name: "File report.md" })).toHaveCount(1);

      await transcript(page).getByRole("link", { name: "Compact CSV" }).click();
      await expect(page.getByRole("region", { name: "File summary.csv" })).toContainText("WashU", {
        timeout: 30_000,
      });

      await transcript(page).getByRole("link", { name: "Elsewhere" }).click();
      await expect(page.getByText(/outside\.md is outside this chat's folder/)).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByRole("region", { name: "File outside.md" })).toHaveCount(0);

      const site = transcript(page).getByRole("link", { name: "Example site" });
      await expect(site).toHaveAttribute("href", "https://example.com/");
      await expect(site).toHaveAttribute("target", "_blank");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "on a phone, a link to a file opens it over the screen, and the back button returns to the chat",
    async ({ realApp, browser }) => {
      seedFiles(realApp.folder);
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      // A phone opens in a new chat.
      const page = await realApp.open({ path: "/", context });
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", /^Fake Model/, { timeout: 120_000 });
      await box.fill("file_links");
      await page.getByRole("button", { name: "Send" }).tap();
      const csv = transcript(page).getByRole("link", { name: "Compact CSV" });
      await expect(csv).toBeVisible({ timeout: 90_000 });

      await csv.tap();
      const file = page.getByRole("region", { name: "File summary.csv" });
      await expect(file).toContainText("WashU", { timeout: 30_000 });
      await page.getByRole("button", { name: "Chat", exact: true }).tap();
      await expect(file).toHaveCount(0);
      await expect(csv).toBeVisible();
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );
});
