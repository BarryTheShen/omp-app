import { join } from "node:path";
import { expect, realTest, screenshots } from "./real-omp";

/**
 * omp writes a "late diagnostics" note into a chat when a language server reports after an edit or write has
 * finished (`customType: "lsp-late-diagnostic"`, `details.files[]` with a path, a summary, an errored flag and
 * omp's own lines as text; omp v18.8.9 `sdk.ts:414-446`). No language server runs here, so this opens a chat made
 * of that entry, shaped as omp writes it, in the real app on real omp: the note is the Diagnostics card (closed, with its
 * state), opens to omp's line as written, and is not the generic "Unable to render" note.
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
      content: [{ type: "text", text: "Fix the total in cart.ts." }],
      timestamp: at,
    },
  },
  assistant("I edited cart.ts.", at + 1_000),
  {
    type: "custom_message",
    customType: "lsp-late-diagnostic",
    content: "Late diagnostics for cart.ts",
    display: true,
    details: {
      files: [
        {
          path: "/tmp/cart.ts",
          summary: "1 error(s)",
          errored: true,
          messages: ["cart.ts:41:9 [error] [typescript] Property 'total' does not exist (2339)"],
        },
      ],
    },
    timestamp: "2026-10-03T12:00:00.000Z",
  },
  assistant("The edit is done.", at + 120_000),
];

realTest.use({ seedEntries: { entries } });

realTest(
  "a late diagnostics note in a real chat is the Diagnostics card and shows omp's line as written",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("The edit is done.")).toBeVisible({ timeout: 60_000 });

    const header = page.getByRole("button", { name: "Diagnostics: Complete" });
    await expect(header).toHaveCount(1);
    await header.click();
    const card = page
      .locator("[data-message-id]")
      .filter({ hasText: "Property 'total' does not exist" });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("cart.ts:41:9");
    await expect(card).toContainText("/tmp/cart.ts");
    await expect(page.getByText("Unable to render this omp message.")).toHaveCount(0);
    await page.getByRole("region", { name: "Conversation transcript" }).screenshot({
      path: join(screenshots, "t2.6-in-thread-light.png"),
    });
  },
);
