import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  realTest,
  type SeedToolResult,
  screenshots,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue #844. A bash call that printed more than 12 lines showed 12 and a bare ellipsis, and nothing
 * in the app reached the rest. These are bash tool results seeded into one real chat, shaped as omp
 * v18.6.1 sends them: `content` holds the output and omp's wall-time footer, and `details` holds
 * `wallTimeMs` (`packages/coding-agent/src/tools/bash.ts:727-784`) and, when omp cut the output,
 * `meta.truncation` (`packages/coding-agent/src/tools/output-meta.ts`, `truncationFromSummary`).
 */

const WALL_TIME = "\n\nWall time: 0.01 seconds";

function numbered(count: number, label: string, width: number): string {
  const numbers = Array.from({ length: count }, (_, index) =>
    String(index + 1).padStart(width, "0"),
  );
  return numbers.map((number) => `${label} ${number}`).join("\n");
}

function bash(
  command: string,
  text: string,
  wallTimeMs: number,
  details: Record<string, unknown> = {},
): SeedToolResult {
  return {
    toolName: "bash",
    args: { command },
    result: { content: [{ type: "text", text }], details: { wallTimeMs, ...details } },
    isError: false,
  };
}

const colored = Array.from(
  { length: 14 },
  (_, index) => `\u001b[32mpass\u001b[0m case ${String(index + 1).padStart(2, "0")}`,
).join("\n");

const commits = Array.from(
  { length: 20 },
  (_, index) => `${(0x1a2b3c + index).toString(16)} commit ${index + 1}`,
).join("\n");

const SAMPLES: readonly SeedToolResult[] = [
  bash(
    'for i in $(seq -w 1 40); do echo "line $i"; done',
    `${numbered(40, "line", 2)}${WALL_TIME}`,
    13,
  ),
  bash('seq -f "row %03g" 1 400', `${numbered(400, "row", 3)}\n\nWall time: 0.42 seconds`, 420),
  bash("./check.sh", `${colored}${WALL_TIME}`, 88),
  bash("true", "\n\nWall time: 0.00 seconds", 2),
  bash("git log --oneline -n 4000", `${commits}${WALL_TIME}`, 31, {
    meta: {
      truncation: {
        direction: "tail",
        truncatedBy: "lines",
        totalLines: 4000,
        outputLines: 20,
        totalBytes: 262144,
        outputBytes: 1200,
        artifactId: "1",
      },
    },
  }),
];

realTest.use({ seedToolResults: { results: SAMPLES } });

realTest(
  "a bash card shows every line of its output, with a note and a control for the rest",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("end of sample 4")).toBeVisible({ timeout: 60_000 });
    const rows = page.locator('[data-slot="u1-message-row"][data-role="assistant"]');
    await expect(rows).toHaveCount(SAMPLES.length);
    await mkdir(screenshots, { recursive: true });

    // 40 lines: the first 12 and a note, then every line on request.
    const forty = rows.nth(0);
    const fortyOutput = forty.getByTestId("u3-bash-stdout");
    await expect(fortyOutput).toContainText("line 12");
    await expect(fortyOutput).not.toContainText("line 13");
    await expect(forty.getByText("Showing the first 12 of 40 lines.")).toBeVisible();
    await forty.screenshot({ path: join(screenshots, "u3-bash-output-light-preview.png") });
    await forty.getByRole("button", { name: "Show all 40 lines" }).click();
    await expect(fortyOutput).toContainText("line 40");
    await expect(forty.getByRole("button", { name: "Show fewer lines" })).toBeVisible();
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await forty.screenshot({ path: join(screenshots, "u3-bash-output-dark-expanded.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 900 });
    await waitForFiniteAnimations(page);
    await forty.screenshot({ path: join(screenshots, "u3-bash-output-narrow-expanded.png") });
    await page.setViewportSize({ width: 1280, height: 1000 });

    // 400 lines: the last line is reachable.
    const fourHundred = rows.nth(1);
    await expect(fourHundred.getByText("Showing the first 12 of 400 lines.")).toBeVisible();
    await fourHundred.getByRole("button", { name: "Show all 400 lines" }).click();
    await expect(fourHundred.getByTestId("u3-bash-stdout")).toContainText("row 400");

    // Colors: 12 colored lines in the preview, all 14 once every line shows.
    const ansi = rows.nth(2);
    await expect(ansi.getByTestId("u3-bash-stdout").locator(".text-success")).toHaveCount(12);
    await ansi.getByRole("button", { name: "Show all 14 lines" }).click();
    await expect(ansi.getByTestId("u3-bash-stdout").locator(".text-success")).toHaveCount(14);

    // Empty output: "No output", and no note or control.
    const empty = rows.nth(3);
    await expect(empty.getByText("No output")).toBeVisible();
    await expect(empty.getByRole("button", { name: /Show/ })).toHaveCount(0);

    // Shortened by omp: its own counts, and the lines it kept.
    const shortened = rows.nth(4);
    await expect(
      shortened.getByText("omp shortened this output: showing 20 of 4,000 lines."),
    ).toBeVisible();
    await expect(shortened.getByRole("button", { name: "Show all 20 lines" })).toBeVisible();
    await shortened.screenshot({ path: join(screenshots, "u3-bash-output-shortened-light.png") });
  },
);
