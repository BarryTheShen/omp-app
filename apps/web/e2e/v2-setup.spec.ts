import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * Set up omp-app: questions (each can be skipped), then one plan of every setting that would change (now → after), and
 * only on Apply the changes; Settings → App → Undo setup puts them back.
 */
const dialog = (page: Page) => page.getByRole("dialog");
const next = (page: Page) => dialog(page).getByRole("button", { name: "Next", exact: true });
const skip = (page: Page) => dialog(page).getByRole("button", { name: "Skip", exact: true });
const pick = async (page: Page, label: string): Promise<void> => {
  await dialog(page).getByRole("radio", { name: label, exact: true }).click();
  await next(page).click();
};
const openApp = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-tour="settings-tab-app"]').click();
};

realTest.describe("set up omp-app", () => {
  realTest.use({ seedSessions: 1 });

  realTest(
    "answers become a plan of changes; Apply makes them, Undo setup puts them back",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(180_000);
      const page = await realApp.open({ path: "/" });
      await expect(
        page
          .getByRole("navigation", { name: "Chats" })
          .getByRole("button", { name: "Seeded chat 1" }),
      ).toBeVisible({ timeout: 120_000 });
      const html = page.locator("html");
      const settings = () => readFile(join(realApp.agentDir, "config.yml"), "utf8").catch(() => "");

      await openApp(page);
      await page.getByRole("button", { name: "Set up", exact: true }).click();
      await expect(dialog(page)).toContainText("Set up omp-app · 1 of 10");
      await dialog(page).getByRole("checkbox", { name: "Study and notes" }).click();
      await next(page).click();
      await skip(page).click(); // where
      await pick(page, "Watch it work");
      await pick(page, "Not now");
      await pick(page, "Light");
      await skip(page).click(); // style
      await skip(page).click(); // tool calls
      await pick(page, "Keep them open");
      await skip(page).click(); // approval: the preset's
      await skip(page).click(); // usage limits

      // Nothing has changed yet: the plan lists what would.
      await expect(dialog(page).getByRole("heading", { name: "Your setup" })).toBeVisible();
      const changes = dialog(page).getByRole("list", { name: "Changes" });
      // A new app starts dark.
      await expect(changes).toContainText("Light or dark: dark → light");
      await expect(changes).toContainText("Close workspaces not used for: 12 hours → never");
      await expect(changes).toContainText("omp: thinking level: high → medium");
      await expect(changes).toContainText(
        "omp: ask before acting: never (just work) → before every action",
      );
      expect(await settings()).not.toMatch(/approvalMode/);
      await page.screenshot({ path: testInfo.outputPath("setup-plan.png") });

      // Untick one: it stays as it is.
      await changes.getByRole("checkbox", { name: "omp: thinking level" }).click();
      await dialog(page).getByRole("button", { name: "Apply", exact: true }).click();
      await expect(dialog(page)).toContainText("omp-app is set up");
      await expect(dialog(page)).toContainText("3 settings changed");
      await expect(html).toHaveAttribute("data-theme", /light/);
      await expect.poll(settings).toMatch(/approvalMode: always-ask/);
      expect(await settings()).not.toMatch(/defaultThinkingLevel/);
      await dialog(page).getByRole("button", { name: "Done", exact: true }).click();

      // Undo setup: omp's default again (the key out of the file), the theme as it was.
      await openApp(page);
      await page.getByRole("button", { name: "Undo setup", exact: true }).click();
      await expect.poll(settings).not.toMatch(/approvalMode/);
      await expect(html).toHaveAttribute("data-theme", /dark/);
      await expect(page.getByRole("button", { name: "Undo setup", exact: true })).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "Fine-tune with omp asks in a new chat; its proposal opens as a plan to review, and only Apply writes it",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(180_000);
      const page = await realApp.open({ path: "/" });
      await expect(
        page
          .getByRole("navigation", { name: "Chats" })
          .getByRole("button", { name: "Seeded chat 1" }),
      ).toBeVisible({ timeout: 120_000 });
      const settings = () => readFile(join(realApp.agentDir, "config.yml"), "utf8").catch(() => "");

      await openApp(page);
      await page.getByRole("button", { name: "Set up", exact: true }).click();
      for (let step = 0; step < 10; step++) await skip(page).click();
      await dialog(page).getByRole("button", { name: "Apply", exact: true }).click();
      await dialog(page).getByRole("button", { name: "Fine-tune with omp", exact: true }).click();

      // omp's answer in the new chat: the block, with Review these settings.
      const transcript = page.getByRole("region", { name: "Transcript" });
      const review = transcript.getByRole("button", { name: "Review these settings" });
      await expect(review).toBeVisible({ timeout: 90_000 });
      expect(await settings()).not.toMatch(/approvalMode/);
      await review.click();
      await expect(dialog(page).getByRole("heading", { name: "omp's proposal" })).toBeVisible();
      const changes = dialog(page).getByRole("list", { name: "Changes" });
      await expect(changes).toContainText(
        "omp: ask before acting: never (just work) → before changing files",
      );
      await expect(changes).toContainText("You review file changes");
      await expect(dialog(page).getByRole("list", { name: "Left out" })).toContainText(
        "no.such.setting",
      );
      await dialog(page).getByRole("button", { name: "Apply", exact: true }).click();
      await expect.poll(settings).toMatch(/approvalMode: write/);
      expect(realApp.problems).toEqual([]);
    },
  );
});
