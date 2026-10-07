import { join } from "node:path";
import type { Page } from "@playwright/test";
import { U1_REAL_ENDINGS } from "../src/modules/U1/fixtures/real-endings";
import { expect, realTest, screenshots } from "./real-omp";

/**
 * An answer can end in a provider error (a model that is not there, a stalled stream), be
 * interrupted, or be cut by the length limit. omp records why. This opens a chat of real endings
 * (`modules/U1/fixtures/real-endings.ts`) in the real app on real omp: each answer shows its reason
 * once, an error omp retried shows only the answer that followed, and a plain answer has no extra
 * line. The same after a reload.
 */

const at = Date.UTC(2026, 9, 3, 11, 0, 0);
const entries = U1_REAL_ENDINGS.flatMap((ending, index) => [
  {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: `Question ${index + 1}: ${ending.name}` }],
      timestamp: at + index * 10_000 - 500,
    },
  },
  ...ending.entries.map((entry) => ({
    ...entry,
    message: {
      ...(entry.message as Record<string, unknown>),
      timestamp: Number((entry.message as { timestamp: number }).timestamp) + index * 10_000,
    },
  })),
]);

realTest.use({ seedEntries: { entries } });

const collapse = (text: string) => text.replace(/\s+/g, " ");

async function check(page: Page, label: string) {
  await expect(page.getByText("A normal answer.")).toBeVisible({ timeout: 60_000 });
  const rows = page.locator('[data-slot="u1-message-row"][data-role="assistant"]');
  await expect(rows, `${label}: one answer row per question`).toHaveCount(U1_REAL_ENDINGS.length);
  for (const [index, ending] of U1_REAL_ENDINGS.entries()) {
    const text = collapse(await rows.nth(index).innerText());
    for (const wanted of ending.shows) {
      expect(text, `${label}: ${ending.name}`).toContain(collapse(wanted));
    }
    for (const unwanted of ending.absent) {
      expect(text, `${label}: ${ending.name}`).not.toContain(collapse(unwanted));
    }
  }
  await expect(page.getByText("Unable to render this omp message.")).toHaveCount(0);
}

realTest("an answer says why it stopped when it did not finish normally", async ({ realApp }) => {
  const page = await realApp.open();
  await page.setViewportSize({ width: 1100, height: 1700 });
  await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
  await check(page, "first open");
  await page.getByRole("region", { name: "Conversation transcript" }).screenshot({
    path: join(screenshots, "message-endings", "endings-light.png"),
  });

  await page.reload();
  await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
  await check(page, "after a reload");
});
