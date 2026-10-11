import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #915. omp's discardEntryDurably writes an empty branch_summary when it discards a message from
 * the active path. The chat shows no row for it, but Conversation history listed it as "Conversation
 * summary: No preview is available for this message...". History now says a message was discarded here.
 */

const DISCARDED = "A message was discarded here.";
const NARROW = { width: 390, height: 844 } as const;
const CHORD = "Control+Shift+H";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const at = Date.UTC(2026, 9, 6, 10, 0, 0);
const user = (text: string, timestamp: number) => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }], timestamp },
});
const assistant = (text: string, timestamp: number) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake",
    model: "fake-model",
    usage,
    stopReason: "stop",
    timestamp,
  },
});

const entries = [
  user("Try the parser on a new branch.", at),
  assistant("I tried it on the new branch.", at + 1_000),
  {
    type: "branch_summary",
    fromId: "entry-left-branch",
    summary: "User explored another conversation branch, then returned here.",
    timestamp: new Date(at + 2_000).toISOString(),
  },
  {
    type: "branch_summary",
    fromId: "entry-discarded",
    summary: "",
    timestamp: new Date(at + 3_000).toISOString(),
  },
  assistant("Back on the main branch.", at + 120_000),
];

realTest.use({ seedEntries: { entries } });

/** Opens the seeded chat and the Conversation history panel with its chord. */
async function openHistory(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
  await expect(page.getByText("Back on the main branch.")).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press(CHORD);
  await expect(page.getByRole("tab", { name: "Conversation history" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

realTest(
  "Conversation history says a message was discarded here, not that no preview exists",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await openHistory(page);
    await expect(page.getByText(DISCARDED)).toBeVisible();
    await expect(page.getByText("No preview is available")).toHaveCount(0);
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-915-history-light.png") });

    await page.emulateMedia({ colorScheme: "dark" });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-915-history-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });

    // At 390 px the panels are a drawer: the resize closes them, and the chord opens the drawer again.
    await page.setViewportSize(NARROW);
    await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
    await page.keyboard.press(CHORD);
    await expect(page.getByRole("tab", { name: "Conversation history" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByText(DISCARDED)).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-915-history-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);
