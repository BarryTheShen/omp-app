import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, openAllToolCards, realTest, type SeedToolResult, screenshots } from "./real-omp";

/**
 * Issue #845. A bash card's output could not be copied: its only copy control copied the command,
 * and that gave no sign that it had worked. Now the output has its own control, which copies the
 * whole output, not only the lines the card shows, and each copy says what it copied; the words clear
 * after about a second and a half. This is a bash tool result seeded into one real chat on real omp,
 * shaped as omp sends it.
 */
const COMMAND = 'for i in $(seq -w 1 40); do echo "line $i"; done';
const OUTPUT = Array.from(
  { length: 40 },
  (_, index) => `line ${String(index + 1).padStart(2, "0")}`,
).join("\n");

const SAMPLES: readonly SeedToolResult[] = [
  {
    toolName: "bash",
    args: { command: COMMAND },
    result: {
      content: [{ type: "text", text: `${OUTPUT}\n\nWall time: 0.01 seconds` }],
      details: { wallTimeMs: 13 },
    },
    isError: false,
  },
];

realTest.use({ seedToolResults: { results: SAMPLES } });

realTest(
  "the output and the command of a bash card copy, and each copy says so",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("end of sample 0")).toBeVisible({ timeout: 60_000 });
    await openAllToolCards(page);
    await mkdir(screenshots, { recursive: true });
    const row = page.locator('[data-slot="u1-message-row"][data-role="assistant"]').nth(0);

    // The output copies whole: all 40 lines, though the card shows the first 12.
    await row.getByRole("button", { name: "Copy raw output" }).click();
    await expect(row.getByText("Copied raw output", { exact: true })).toBeVisible();
    await row.screenshot({ path: join(screenshots, "u3-bash-copy-light.png") });
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(OUTPUT);

    // The command copies too, and says so.
    await row.getByRole("button", { name: "Copy bash command" }).click();
    await expect(row.getByText("Copied command", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(COMMAND);

    // The confirmation clears on its own, about a second and a half after it shows.
    await expect(row.getByText("Copied command", { exact: true })).toHaveCount(0, {
      timeout: 5_000,
    });
    await expect(row.getByText("Copied raw output", { exact: true })).toHaveCount(0);

    // Dark and narrow captures are taken while the confirmations are on screen.
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await row.getByRole("button", { name: "Copy raw output" }).click();
    await expect(row.getByText("Copied raw output", { exact: true })).toBeVisible();
    await row.screenshot({ path: join(screenshots, "u3-bash-copy-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 900 });
    await row.getByRole("button", { name: "Copy bash command" }).click();
    await expect(row.getByText("Copied command", { exact: true })).toBeVisible();
    await row.screenshot({ path: join(screenshots, "u3-bash-copy-narrow.png") });
  },
);
