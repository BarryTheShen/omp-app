import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * P4.5 in the app, on real omp: a chat whose session file holds a label entry (omp writes one with
 * `appendLabelChange`, `selector-controller.ts:1481` in omp v18.6.1). The Conversation history panel
 * opens with Ctrl+Shift+H and lists the label under "Labels", with the time of the entry it names.
 * The read-only sentence is stated once in the panel: while labels are shown, the tree's notice
 * carries it, and the labels footer leaves its copy out. At 390 px the panels are a drawer.
 */

const REASON = "Labels can only be changed in omp's terminal for now.";
const CHORD = "Control+Shift+H";
const NARROW = { width: 390, height: 844 } as const;
const at = Date.UTC(2026, 9, 3, 11, 0, 0);

// omp writes every session entry's top-level `timestamp` as an ISO-8601 string (`SessionEntryHead`
// in packages/contracts/src/core/ids.ts). The message inside a message entry keeps its numeric time.
const iso = (ms: number): string => new Date(ms).toISOString();

// The harness chains these entries and gives them the ids e000000, e000001, ... in order, so the
// label's target is the first message. omp's label entry is `{ type: "label", targetId, label }`
// (`session-entries.ts:186-190` in omp v18.6.1).
const entries = [
  {
    type: "message",
    timestamp: iso(at),
    message: {
      role: "user",
      content: [{ type: "text", text: "Plan the migration" }],
      timestamp: at,
    },
  },
  {
    type: "message",
    timestamp: iso(at + 1_000),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Here is the plan." }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      stopReason: "stop",
      usage: { input: 1200, output: 180, cacheRead: 0, cacheWrite: 0, totalTokens: 1380 },
      timestamp: at + 1_000,
    },
  },
  { type: "label", targetId: "e000000", label: "Review checkpoint", timestamp: iso(at + 2_000) },
];

realTest.use({ seedEntries: { entries } });
realTest.setTimeout(240_000);

/** The Labels list, its count and the reason, as the open Conversation history panel shows them. */
async function expectLabels(page: Page): Promise<void> {
  // The panel reads the chat's entries and labels when it opens: they are there once it shows them.
  await expect(page.getByRole("region", { name: "Conversation history" })).toHaveAttribute(
    "data-panel-lifecycle",
    "populated",
    { timeout: 60_000 },
  );
  const labels = page.getByRole("region", { name: "Labels" });
  await expect(labels.getByRole("list", { name: "Labels" })).toBeVisible();
  await expect(labels.getByText("Review checkpoint", { exact: true })).toBeVisible();
  await expect(labels.getByText(/^Entry from /)).toBeVisible();
  await expect(labels.getByText("1 label", { exact: true })).toBeVisible();
  const panel = page.locator('[data-rewind-panel="true"]');
  await expect(panel.getByText(REASON, { exact: true })).toHaveCount(1);
}

realTest(
  "the Conversation history panel lists a session's labels, and states the reason once",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    // The seeded reply is on screen before the panel opens: the chat's history loads after it is selected.
    await expect(page.getByText("Here is the plan.", { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await page.getByRole("textbox", { name: "Message input" }).focus();
    await page.keyboard.press(CHORD);
    await expect(page.getByRole("tab", { name: "Conversation history" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expectLabels(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "p4-5-labels-real-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "p4-5-labels-real-dark.png") });

    // At 390 px the layout is narrow: the resize closes the panels, and the chord opens the drawer.
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize(NARROW);
    await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute(
      "data-open",
      "false",
    );
    await page.keyboard.press(CHORD);
    await expect(page.getByRole("tab", { name: "Conversation history" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expectLabels(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "p4-5-labels-real-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);
