import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, REAL_OMP, realTest, startNewChat } from "./real-omp";

/**
 * The dashboard's overview and graphs (#15) on real omp: the overview's figures and the fake provider's window as a
 * gauge; Chats lists the running chat with its model, and pauses and continues it; Usage draws the windows over the day
 * and each window by chat; Statistics draws the cost of each day. This spec's stand-in omp reports the fake provider's
 * 5-hour window at 60%.
 */
const MINUTE = 60_000;
const START = Date.now();
const usageFixture = {
  generatedAt: START,
  reports: [
    {
      provider: "fake",
      fetchedAt: START,
      metadata: {},
      limits: [
        {
          id: "fake:5h",
          label: "5 Hour",
          window: { id: "5h", label: "5 Hour", resetsAt: START + 30 * MINUTE },
          amount: { usedFraction: 0.6 },
        },
      ],
    },
  ],
};
const FIXTURE_DIRECTORY = mkdtempSync(join(tmpdir(), "omp-app-v2-dashboard-overview-"));
const FIXTURE_FILE = join(FIXTURE_DIRECTORY, "usage.json");
const WRAPPER = join(FIXTURE_DIRECTORY, "omp");
writeFileSync(FIXTURE_FILE, `${JSON.stringify(usageFixture)}\n`);
writeFileSync(
  WRAPPER,
  `#!/bin/sh\nif [ "$1" = "usage" ]; then cat "${FIXTURE_FILE}"; exit 0; fi\nexec "${REAL_OMP}" "$@"\n`,
);
chmodSync(WRAPPER, 0o755);
realTest.use({ ompBinary: WRAPPER });

const dashboard = (page: Page) => page.locator('[data-tour="dashboard"]');

realTest.describe("new UI: the dashboard's overview and graphs", () => {
  realTest.setTimeout(240_000);

  realTest(
    "the overview, its gauges and figures; Chats pauses and continues a chat; the graphs of use and spend",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill("hello");
      await box.press("Enter");
      await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });

      await page.getByRole("button", { name: "Dashboard", exact: true }).click();
      const overview = dashboard(page).getByRole("region", { name: "Overview" });
      await expect(overview).toContainText("Spent in 24 hours");
      await expect(overview).toContainText("Chats running");
      await expect(overview.getByRole("img", { name: /^fake, 5 Hour: 60% used/ })).toBeVisible({
        timeout: 60_000,
      });

      // Chats: the chat with its model; paused from here, and continued.
      const chats = dashboard(page).getByRole("region", { name: "Chats" });
      const row = chats.getByRole("listitem").first();
      await expect(row).toContainText("Fake Model", { timeout: 30_000 });
      await row.getByRole("button", { name: /^Pause / }).click();
      await expect(row).toContainText("Paused", { timeout: 30_000 });
      await row.getByRole("button", { name: /^Continue / }).click();
      await expect(row).not.toContainText("Paused", { timeout: 30_000 });

      // Usage: the windows over the day, and each window by chat.
      await expect(dashboard(page).getByRole("region", { name: "Over the day" })).toBeVisible();
      await expect(dashboard(page).getByRole("region", { name: "Each chat's part" })).toContainText(
        "fake · 60% used",
        { timeout: 30_000 },
      );

      // Statistics: the cost of each day, drawn. The section reads omp's statistics once it shows; the parts bar
      // brings it into view.
      await dashboard(page)
        .getByRole("navigation", { name: "Dashboard parts" })
        .getByRole("button", { name: "Statistics" })
        .click();
      await expect(
        dashboard(page)
          .getByRole("region", { name: "Statistics" })
          .getByRole("img", { name: /^Cost per day/ }),
      ).toBeVisible({ timeout: 120_000 });
      expect(realApp.problems).toEqual([]);
    },
  );
});
