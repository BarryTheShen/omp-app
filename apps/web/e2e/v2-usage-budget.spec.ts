import { chmodSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, REAL_OMP, realTest, startNewChat } from "./real-omp";

/**
 * A chat's own budget (#14) on real omp: Usage says the chat's own part of its provider's 5-hour window; a budget under
 * that part pauses the chat (omp's `/pause`) and the chat and Usage say why; the server keeps budget and hold across a
 * reload; and a budget over the part lets the chat go on. The chats run on the fake provider, whose 5-hour window the
 * stand-in omp reports at 60%. The fake model's replies carry no tokens, so the server's count of each chat's part is
 * written into the app's data folder (`usage-shares.json`, as the server keeps it) and read at a restart.
 */
const MINUTE = 60_000;
const START = Date.now();
const RESETS_AT = START + 30 * MINUTE;

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
          window: { id: "5h", label: "5 Hour", resetsAt: RESETS_AT },
          amount: { usedFraction: 0.6 },
        },
      ],
    },
  ],
};

// A stand-in for omp: `omp usage` prints the fixture, and every other call runs the real omp.
const FIXTURE_DIRECTORY = mkdtempSync(join(tmpdir(), "omp-app-v2-usage-budget-"));
const FIXTURE_FILE = join(FIXTURE_DIRECTORY, "usage.json");
const WRAPPER = join(FIXTURE_DIRECTORY, "omp");
writeFileSync(FIXTURE_FILE, `${JSON.stringify(usageFixture)}\n`);
writeFileSync(
  WRAPPER,
  `#!/bin/sh\nif [ "$1" = "usage" ]; then cat "${FIXTURE_FILE}"; exit 0; fi\nexec "${REAL_OMP}" "$@"\n`,
);
chmodSync(WRAPPER, 0o755);
realTest.use({ ompBinary: WRAPPER });

/** The server's count of the fake provider's window: each of `chats` at 25% of it, $1.50 each. */
function sharesFile(chats: readonly string[]): string {
  const parts = Object.fromEntries(chats.map((id) => [id, [25, 1.5, 3_000]]));
  return `${JSON.stringify({
    version: 1,
    windows: { fake: [60, RESETS_AT, Math.max(0, 60 - 25 * chats.length), START, parts] },
    spent: {},
  })}\n`;
}

const section = (page: Page) => page.getByRole("region", { name: "Its own budget" });
const toggle = (page: Page) =>
  section(page).getByRole("switch", { name: "Pause this chat after its own part" });
const percent = (page: Page) =>
  section(page).getByRole("textbox", { name: "Pause after this chat's own percent" });
const paused = (page: Page) => page.locator('[data-tour="paused"]');

async function setPercent(page: Page, value: string): Promise<void> {
  await percent(page).fill(value);
  await percent(page).press("Enter");
}

realTest.describe("new UI: a chat's own budget of its provider's window", () => {
  realTest.setTimeout(300_000);

  realTest(
    "Usage says the chat's own part; a budget under it pauses the chat and says why, across a reload; over it the chat goes on",
    async ({ realApp }) => {
      const first = await realApp.open({ path: "/" });
      await startNewChat(first);
      const box = first.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill("hello");
      await box.press("Enter");
      await expect(first.getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });

      // The chat's id is its omp session's, as its file is named (`<time>_<id>.jsonl`): the newest such file.
      const sessions = join(realApp.agentDir, "sessions");
      const files = readdirSync(sessions, { recursive: true, encoding: "utf8" });
      const named = files
        .map((name) => ({
          name,
          id: /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(
            name,
          )?.[1],
        }))
        .filter((file): file is { name: string; id: string } => file.id !== undefined)
        .sort(
          (a, b) =>
            statSync(join(sessions, b.name)).mtimeMs - statSync(join(sessions, a.name)).mtimeMs,
        );
      expect(named.length, files.join(", ")).toBeGreaterThan(0);
      const threads = [named[0]?.id ?? ""];
      const context = first.context();
      await first.close();
      await writeFile(join(realApp.appDataDir, "usage-shares.json"), sharesFile(threads));
      await realApp.restartServer();
      const page = await realApp.open({ path: "/", context });
      await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });

      // Usage says the chat's own part of the window and what it spent there.
      await page.keyboard.press("Control+Alt+KeyB");
      await expect(section(page)).toContainText(
        "This chat used about 25% of fake's 5-hour window ($1.50).",
        { timeout: 60_000 },
      );
      await expect(percent(page)).toHaveValue("40");
      await expect(toggle(page)).toBeEnabled({ timeout: 30_000 });

      // A budget of 40%: its part is under it, and the chat runs on.
      await toggle(page).click();
      await expect(toggle(page)).toBeChecked();
      await expect(paused(page)).toHaveCount(0);

      // 20%: its 25% is past it, so the chat pauses at once, and both the chat and Usage say why.
      await setPercent(page, "20");
      await expect(paused(page)).toContainText(
        /At its own part of fake's 5-hour window · resumes at \d/,
        { timeout: 30_000 },
      );
      await expect(section(page).getByRole("status")).toContainText(
        "Paused at its own 20% · resumes at",
      );
      // The mark's own section says nothing of it: the budget holds the chat, not the mark.
      await expect(
        page.getByRole("region", { name: "Pause at the limit" }).getByRole("status"),
      ).toHaveCount(0);

      // The server keeps the budget and the hold: a reload shows both.
      await page.reload();
      await expect(toggle(page)).toBeChecked({ timeout: 60_000 });
      await expect(percent(page)).toHaveValue("20");
      await expect(paused(page)).toContainText("At its own part of fake's 5-hour window", {
        timeout: 30_000,
      });

      // 30%: over its part, so the chat goes on at once.
      await setPercent(page, "30");
      await expect(paused(page)).toHaveCount(0, { timeout: 30_000 });
      await expect(section(page).getByRole("status")).toHaveCount(0);

      // Off: no budget is kept.
      await toggle(page).click();
      await expect(toggle(page)).not.toBeChecked();
      await page.reload();
      await expect(toggle(page)).not.toBeChecked({ timeout: 60_000 });
      await expect(toggle(page)).toBeEnabled({ timeout: 30_000 });
      expect(realApp.problems).toEqual([]);
    },
  );
});
