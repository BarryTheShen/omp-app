import { join } from "node:path";
import type { Page } from "@playwright/test";
import { U1_REAL_ENTRIES } from "../src/modules/U1/fixtures/real-entries";
import { expect, realTest, screenshots } from "./real-omp";

/**
 * omp puts its own messages into a chat: a finished subagent with its result, a message from another
 * agent, the advisor, a finished process. Some are for the model alone (`display: false`). This opens
 * a chat made of real entries of each kind (`modules/U1/fixtures/real-entries.ts`) in the real app on
 * real omp: every shown one is a note with its heading and text, in order and once; none of the
 * hidden ones is on the page; and nothing says 'Unable to render'. The same after a reload.
 */

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
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

const at = Date.UTC(2026, 9, 3, 11, 59, 0);
const entries = [
  {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: "Start two helpers." }],
      timestamp: at,
    },
  },
  assistant("I started the helpers.", at + 1_000),
  ...U1_REAL_ENTRIES.map((sample) => sample.entry),
  assistant("Both helpers have answered.", at + 120_000),
];

realTest.use({ seedEntries: { entries } });

const collapse = (text: string) => text.replace(/\s+/g, " ");

async function check(page: Page, label: string) {
  const shown = U1_REAL_ENTRIES.filter((sample) => !sample.hidden);
  await expect(page.getByText("Both helpers have answered.")).toBeVisible({ timeout: 60_000 });
  const notes = page.locator('[data-slot="u1-custom-note"]');
  await expect(notes, `${label}: one note per shown message`).toHaveCount(shown.length);
  for (const [index, sample] of shown.entries()) {
    const text = collapse(await notes.nth(index).innerText());
    for (const wanted of sample.shows) {
      expect(text, `${label}: ${sample.name}`).toContain(collapse(wanted));
    }
  }
  for (const sample of U1_REAL_ENTRIES.filter((candidate) => candidate.hidden)) {
    await expect(
      page.getByText(sample.hiddenText ?? "", { exact: false }),
      sample.name,
    ).toHaveCount(0);
  }
  await expect(page.getByText("Unable to render this omp message.")).toHaveCount(0);
}

realTest(
  "omp's own messages are notes in the chat; the ones for the model are not",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1100, height: 1500 });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await check(page, "first open");
    await page.getByRole("region", { name: "Conversation transcript" }).screenshot({
      path: join(screenshots, "custom-messages", "notes-light.png"),
    });

    await page.reload();
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await check(page, "after a reload");
  },
);
