import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots } from "./real-omp";

/**
 * omp writes a `branch_summary` entry when a person leaves a branch they summarized: a preamble, the
 * model's summary, then a `<files>` block of the files that branch read and changed. An entry with an
 * empty summary is omp's internal discard marker and is not shown. This opens a chat made of such
 * entries in the real app on real omp: the summary is one collapsed row; its keyboard toggle opens it
 * to the summary text and both file lists; the marker is no row; the same after a reload.
 */

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const at = Date.UTC(2026, 9, 9, 10, 0, 0);
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

const summary = [
  "User explored another conversation branch, then returned here.",
  "Exploration summary:",
  "",
  "## Goal",
  "Keep the parser stable across the refactor.",
  "",
  "",
  "<files>",
  "# src/",
  "parser.ts (Read)",
  "store.ts (RW)",
  "# src/lib/",
  "hash.ts (Write)",
  "</files>",
].join("\n");

const entries = [
  user("Try the parser on a new branch.", at),
  assistant("I tried it on the new branch.", at + 1_000),
  {
    type: "branch_summary",
    fromId: "entry-left-branch",
    summary,
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

const ROW = '[data-slot="p3-branch-summary-row"]';

/** Opens the seeded chat and checks the summary row, its keyboard toggle and both file lists. */
async function check(page: Page, label: string) {
  await page.setViewportSize({ width: 1100, height: 1500 });
  await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
  await expect(page.getByText("Back on the main branch.")).toBeVisible({ timeout: 60_000 });
  const rows = page.locator(ROW);
  await expect(rows, `${label}: one row for the summary, none for the discard marker`).toHaveCount(
    1,
  );
  const row = rows.first();
  await expect(row.getByText("Branch summary", { exact: true })).toBeVisible();
  await expect(row.locator("details"), `${label}: collapsed at first`).toHaveJSProperty(
    "open",
    false,
  );
  await row.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(row.locator("details")).toHaveJSProperty("open", true);
  await expect(row.locator("summary > svg:last-child")).toHaveCSS("rotate", "180deg");
  await expect(row.getByText("Keep the parser stable across the refactor.")).toBeVisible();
  await expect(row.getByText("Files read", { exact: true })).toBeVisible();
  await expect(row.getByText("src/parser.ts", { exact: true })).toBeVisible();
  await expect(row.getByText("Files changed", { exact: true })).toBeVisible();
  await expect(row.getByText("src/store.ts", { exact: true })).toBeVisible();
  await expect(row.getByText("src/lib/hash.ts", { exact: true })).toBeVisible();
  await expect(row.getByText("<files>", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Unable to render this omp message.")).toHaveCount(0);
}

realTest(
  "a branch summary is one collapsed row that opens to its summary and file lists, also after a reload",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await check(page, "first open");
    await page.getByRole("region", { name: "Conversation transcript" }).screenshot({
      path: join(screenshots, "branch-summary-row", "light.png"),
    });

    await page.reload();
    await check(page, "after a reload");
  },
);

realTest("the branch summary row reads in dark", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open({
    beforeLoad: (target) => target.emulateMedia({ colorScheme: "dark" }),
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await check(page, "dark");
  await page.getByRole("region", { name: "Conversation transcript" }).screenshot({
    path: join(screenshots, "branch-summary-row", "dark.png"),
  });
});

realTest("the branch summary row fits a 390 px phone", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open();
  await check(page, "phone");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.locator(ROW).first().getByText("src/lib/hash.ts", { exact: true }),
  ).toBeVisible();
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(fits).toBe(true);
  await page.getByRole("region", { name: "Conversation transcript" }).screenshot({
    path: join(screenshots, "branch-summary-row", "narrow-390.png"),
  });
});
