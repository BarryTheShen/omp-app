import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 1316. A saved chat whose model omp cannot restore leaves the empty screen with "This chat could not open" and
 * a "Pick a model" button. Choosing another folder must clear that: the other folder's empty screen is the plain one,
 * because the failure belonged to the folder the chat was in. The saved chat is seeded as fix-1153 seeds it: its model
 * is not in omp's catalog.
 */

const SAVED_MODEL = "fake/gone-model";
const SENTENCE = `This chat used ${SAVED_MODEL}, which is not available any more. Pick another model to open it.`;

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const at = Date.UTC(2026, 9, 3, 11, 59, 0);

realTest.use({
  defaultModel: false,
  seedEntries: {
    entries: [
      { type: "model_change", model: SAVED_MODEL },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello from the saved chat" }],
          timestamp: at,
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "the saved answer" }],
          api: "openai-completions",
          provider: "fake",
          model: "fake-model",
          usage,
          stopReason: "stop",
          timestamp: at + 1000,
        },
      },
    ],
  },
});

/** The conversation's region: the empty screen's title and sentence are read from here. */
function transcript(page: Page) {
  return page.getByRole("region", { name: "Conversation transcript" });
}

realTest(
  "switching folder on the empty screen clears the old folder's could-not-open message (issue 1316)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();

    // The workspace folder: the saved chat cannot open, so the empty screen shows its failure and the picker.
    const row = page.getByRole("listbox", { name: "Session list" }).getByRole("option").first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.click();
    await expect(transcript(page).getByText(SENTENCE)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Pick a model", exact: true })).toBeVisible();

    // The other folder: its empty screen is the plain one, and the failure is gone.
    const picker = page.getByRole("combobox", { name: "Workspace folder" });
    await picker.selectOption("__other__");
    await page.getByRole("textbox", { name: "Other folder path" }).fill(realApp.otherFolder);
    await page.getByRole("button", { name: "Use" }).click();
    await expect(picker).toHaveValue(realApp.otherFolder);
    await expect(transcript(page).getByText("Ready when you are")).toBeVisible({ timeout: 30_000 });
    await expect(transcript(page).getByText("This chat could not open")).toHaveCount(0);
    await expect(transcript(page).getByText(SENTENCE)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Pick a model", exact: true })).toHaveCount(0);
    await page.screenshot({ path: join(screenshots, "fix-1316-folder-switch-error-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await expect(transcript(page).getByText("Ready when you are")).toBeVisible();
    await page.screenshot({ path: join(screenshots, "fix-1316-folder-switch-error-dark.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-shell-sidebar="left"]')).toHaveAttribute("data-open", "false");
    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute(
      "data-open",
      "false",
    );
    await waitForFiniteAnimations(page);
    await expect(transcript(page).getByText("Ready when you are")).toBeVisible();
    await page.screenshot({ path: join(screenshots, "fix-1316-folder-switch-error-narrow.png") });
  },
);
