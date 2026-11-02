import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, REAL_OMP, realTest } from "./real-omp";

/**
 * The usage pause (#2781 part 3) on real omp: a chat marked in Usage pauses (omp's `/pause`) once its provider's 5-hour
 * window reaches the chat's own percent, says why and when it goes on, keeps that across a reload, and goes on at once
 * when its percent is raised past the window's share or its mark is removed. The chats run on the fake provider, whose
 * 5-hour window this spec's stand-in omp reports at 60%.
 */
const MINUTE = 60_000;

/** `omp usage --json`'s shape: the fake provider's 5-hour window at 60%, resetting in 30 minutes. */
function usageFixture(now: number): unknown {
  return {
    generatedAt: now,
    reports: [
      {
        provider: "fake",
        fetchedAt: now,
        metadata: {},
        limits: [
          {
            id: "fake:5h",
            label: "5 Hour",
            window: { id: "5h", label: "5 Hour", resetsAt: now + 30 * MINUTE },
            amount: { usedFraction: 0.6 },
          },
        ],
      },
    ],
  };
}

// A stand-in for omp: `omp usage` prints the fixture, and every other call runs the real omp.
const FIXTURE_DIRECTORY = mkdtempSync(join(tmpdir(), "omp-app-v2-usage-pause-"));
const FIXTURE_FILE = join(FIXTURE_DIRECTORY, "usage.json");
const WRAPPER = join(FIXTURE_DIRECTORY, "omp");
writeFileSync(FIXTURE_FILE, `${JSON.stringify(usageFixture(Date.now()))}\n`);
writeFileSync(
  WRAPPER,
  `#!/bin/sh\nif [ "$1" = "usage" ]; then cat "${FIXTURE_FILE}"; exit 0; fi\nexec "${REAL_OMP}" "$@"\n`,
);
chmodSync(WRAPPER, 0o755);
realTest.use({ ompBinary: WRAPPER });

const section = (page: Page) => page.getByRole("region", { name: "Pause at the limit" });
const toggle = (page: Page) =>
  section(page).getByRole("switch", { name: "Pause this chat at its usage limit" });
const percent = (page: Page) =>
  section(page).getByRole("textbox", { name: "Pause at this percent" });
const paused = (page: Page) => page.locator('[data-tour="paused"]');

async function setPercent(page: Page, value: string): Promise<void> {
  await percent(page).fill(value);
  await percent(page).press("Enter");
}

realTest.describe("new UI: pausing a chat at its usage limit", () => {
  realTest.setTimeout(240_000);

  realTest(
    "a marked chat pauses at its own percent of its provider's 5-hour window, says why, and goes on when the percent is raised or the mark removed",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await page
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: "New chat" })
        .click();
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill("hello");
      await box.press("Enter");
      await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });

      // Usage reads the accounts' limits as it opens: the fake provider's window at 60%.
      await page.keyboard.press("Control+Alt+KeyB");
      await expect(
        page
          .getByRole("region", { name: "Your accounts" })
          .getByRole("progressbar", { name: "fake, 5 hour limit" }),
      ).toHaveAttribute("aria-valuenow", "60", { timeout: 90_000 });
      await expect(percent(page)).toHaveValue("95");
      await expect(toggle(page)).toBeEnabled({ timeout: 30_000 });

      // Marked at 95%: the window is under it, and the chat runs on.
      await toggle(page).click();
      await expect(toggle(page)).toBeChecked();
      await expect(paused(page)).toHaveCount(0);

      // 50%: the window's 60% is past it, so the chat pauses at once, and both the chat and Usage say why.
      await setPercent(page, "50");
      await expect(paused(page)).toContainText(/At 50% of fake's 5-hour limit · resumes at \d/, {
        timeout: 30_000,
      });
      await expect(section(page).getByRole("status")).toContainText(
        "Paused at 50% of fake's 5-hour limit · resumes at",
      );

      // The server keeps the mark and the hold: a reload shows both.
      await page.reload();
      await expect(toggle(page)).toBeChecked({ timeout: 60_000 });
      await expect(percent(page)).toHaveValue("50");
      await expect(paused(page)).toContainText("At 50% of fake's 5-hour limit", {
        timeout: 30_000,
      });

      // Raised past the window's share, the chat goes on at once.
      await setPercent(page, "70");
      await expect(paused(page)).toHaveCount(0, { timeout: 30_000 });
      await expect(section(page).getByRole("status")).toHaveCount(0);

      // Held again, then unmarked: the chat goes on, and the mark is gone.
      await setPercent(page, "50");
      await expect(paused(page)).toContainText("At 50% of fake's 5-hour limit", {
        timeout: 30_000,
      });
      await toggle(page).click();
      await expect(toggle(page)).not.toBeChecked();
      await expect(paused(page)).toHaveCount(0, { timeout: 30_000 });
      expect(realApp.problems).toEqual([]);
    },
  );
});
