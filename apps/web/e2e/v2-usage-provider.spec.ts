import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, REAL_OMP, realTest, startNewChat } from "./real-omp";

/**
 * Every chat on a provider (#14) on real omp: Usage's Pause chats and Continue chats on a provider pause and continue
 * its running chats by hand; a rule for every chat on the provider pauses the chat once the provider's 5-hour window is
 * at its percent, the rules list says whom it pauses, and removing the rule lets the chat go on. The chats run on the
 * fake provider, whose 5-hour window this spec's stand-in omp reports at 60%.
 */
const MINUTE = 60_000;
const START = Date.now();

/** `omp usage --json`'s shape: the fake provider's 5-hour window at 60%, resetting in 30 minutes. */
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

// A stand-in for omp: `omp usage` prints the fixture, and every other call runs the real omp.
const FIXTURE_DIRECTORY = mkdtempSync(join(tmpdir(), "omp-app-v2-usage-provider-"));
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
const paused = (page: Page) => page.locator('[data-tour="paused"]');
const workspaces = (page: Page) => page.getByRole("tablist", { name: "Workspaces" });

realTest.describe("new UI: pausing every chat on a provider", () => {
  realTest.setTimeout(240_000);

  realTest(
    "Usage pauses and continues a provider's chats by hand, and a rule for every chat on it pauses them at its percent",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill("hello");
      await box.press("Enter");
      await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });

      // By hand, from Usage: the provider's running chat pauses, and goes on.
      await page.keyboard.press("Control+Alt+KeyB");
      const accounts = page.getByRole("region", { name: "Your accounts" });
      await accounts.getByRole("button", { name: "Pause chats on fake" }).click();
      await expect(accounts.getByRole("status")).toHaveText("Paused 1 chat.", { timeout: 30_000 });
      await expect(paused(page)).toBeVisible({ timeout: 30_000 });
      await accounts.getByRole("button", { name: "Continue chats on fake" }).click();
      await expect(accounts.getByRole("status")).toHaveText("Continued 1 chat.", {
        timeout: 30_000,
      });
      await expect(paused(page)).toHaveCount(0, { timeout: 30_000 });
      await page.keyboard.press("Control+Alt+KeyB");

      // A rule for every chat on fake at 50%: the window's 60% is past it, so the chat pauses.
      await page.getByRole("button", { name: "Dashboard", exact: true }).click();
      const rules = dashboard(page).getByRole("region", { name: "Rules" });
      await expect(rules).toContainText("No rules yet", { timeout: 30_000 });
      await rules.getByRole("button", { name: "New rule" }).click();
      const editor = rules.getByRole("form", { name: "Edit rule" });
      await editor.getByLabel("Name").fill("Every fake chat");
      // A new rule comes with its 5-hour condition on (85%) and day hours on: the hours go, so only the window holds.
      await editor.getByRole("textbox", { name: "5-hour window percent" }).fill("50");
      await editor.getByRole("switch", { name: "the clock is between" }).click();
      await expect(editor.getByLabel("From")).toHaveCount(0);
      await editor.getByRole("radio", { name: "Every chat, also those started later" }).click();
      // Every chat: no chat is picked one by one.
      await expect(editor.getByRole("checkbox")).toHaveCount(0);
      await editor.getByRole("combobox", { name: "Provider" }).click();
      await page.getByRole("option", { name: "fake", exact: true }).click();
      await editor.getByRole("button", { name: "Save rule" }).click();
      await expect(rules).toContainText("Every chat on fake", { timeout: 30_000 });
      await expect(rules).toContainText("holding 1 now", { timeout: 60_000 });

      // The chat, in its own workspace, says a usage rule holds it.
      await workspaces(page).getByRole("tab").first().click();
      await expect(paused(page)).toContainText("By a usage rule: fake's 5-hour window", {
        timeout: 30_000,
      });

      // Removed, the rule lets the chat go on at once.
      await page.getByRole("button", { name: "Dashboard", exact: true }).click();
      await rules.getByRole("button", { name: "Remove Every fake chat" }).click();
      await expect(rules).toContainText("No rules yet", { timeout: 30_000 });
      await workspaces(page).getByRole("tab").first().click();
      await expect(paused(page)).toHaveCount(0, { timeout: 30_000 });
      expect(realApp.problems).toEqual([]);
    },
  );
});
