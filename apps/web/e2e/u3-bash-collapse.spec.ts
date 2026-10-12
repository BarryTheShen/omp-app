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
 * Issue #846, then #1162. The body of a bash card and of an unclaimed tool card sat beside the card, so the
 * header could not fold it; the body now sits inside the card's disclosure. Every finished call starts as one
 * line: its name, its target and its state chip. A click or Enter on the line opens the body, and another one
 * folds it again. A failed call keeps its Error chip on its line while it is folded. These are tool results
 * seeded into one real chat on real omp, shaped as omp sends them.
 */
const SAMPLES: readonly SeedToolResult[] = [
  {
    toolName: "bash",
    args: { command: "printf 'hello from bash'" },
    result: {
      content: [{ type: "text", text: "hello from bash\n\nWall time: 0.01 seconds" }],
      details: { wallTimeMs: 9 },
    },
    isError: false,
  },
  {
    toolName: "some_unlisted_tool",
    args: { query: "fixture" },
    result: { content: [{ type: "text", text: "custom result text" }], details: {} },
    isError: false,
  },
  {
    toolName: "bash",
    args: { command: "sh -c 'echo failed here; exit 2'" },
    result: {
      content: [{ type: "text", text: "failed here\n\nCommand exited with code 2" }],
      details: { wallTimeMs: 4, exitCode: 2 },
    },
    isError: true,
  },
];

realTest.use({ seedToolResults: { results: SAMPLES } });

realTest(
  "a finished bash or unclaimed tool card starts as one line, opens on click and on Enter, and a failed card keeps its Error chip on its line",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("end of sample 2")).toBeVisible({ timeout: 60_000 });
    const rows = page.locator('[data-slot="u1-message-row"][data-role="assistant"]');
    await expect(rows).toHaveCount(SAMPLES.length);
    await mkdir(screenshots, { recursive: true });

    // Bash, finished: one line, with its command and output off the page.
    const bash = rows.nth(0);
    const bashTrigger = bash.getByRole("button", { name: "bash: Complete" });
    await expect(bashTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(bash.getByTestId("u3-bash-stdout")).toHaveCount(0);
    await expect(bash.getByText("$ printf 'hello from bash'")).toHaveCount(0);
    await bash.screenshot({ path: join(screenshots, "u3-bash-collapse-light-folded.png") });

    // A click opens it, and the command and output come back.
    await bashTrigger.click();
    await expect(bashTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(bash.getByText("$ printf 'hello from bash'")).toBeVisible();
    await expect(bash.getByTestId("u3-bash-stdout")).toContainText("hello from bash");
    await expect(bash.getByText("Wall time: 9ms")).toBeVisible();
    await bash.screenshot({ path: join(screenshots, "u3-bash-collapse-light-open.png") });

    // Enter on the focused line folds it; a second Enter opens it again.
    await bashTrigger.focus();
    await page.keyboard.press("Enter");
    await expect(bashTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(bash.getByTestId("u3-bash-stdout")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(bashTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(bash.getByTestId("u3-bash-stdout")).toContainText("hello from bash");
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await bash.screenshot({ path: join(screenshots, "u3-bash-collapse-dark-open.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    // Unclaimed tool, finished: one line; its arguments and text show once it opens.
    const unclaimed = rows.nth(1);
    const unclaimedTrigger = unclaimed.getByRole("button", {
      name: "some_unlisted_tool: Complete",
    });
    await expect(unclaimedTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(unclaimed.getByTestId("t7-fallback-details")).toHaveCount(0);
    await unclaimedTrigger.click();
    await expect(unclaimedTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(unclaimed.getByTestId("t7-fallback-details")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 900 });
    await waitForFiniteAnimations(page);
    await unclaimed.screenshot({
      path: join(screenshots, "u3-bash-collapse-narrow-unclaimed-open.png"),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await unclaimedTrigger.click();
    await expect(unclaimedTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(unclaimed.getByTestId("t7-fallback-details")).toHaveCount(0);

    // Error: one line that keeps its Error chip; its output and omp's reason show once it opens.
    const failed = rows.nth(2);
    const failedTrigger = failed.getByRole("button", { name: "bash: Error" });
    await expect(failedTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(failedTrigger.getByTestId("tool-state-chip-error")).toHaveText("Error");
    await expect(failed.getByTestId("u3-bash-stdout")).toHaveCount(0);
    await failedTrigger.click();
    await expect(failed.getByTestId("u3-bash-stdout")).toContainText("failed here");
    await expect(failed.getByRole("alert")).toContainText("exited with code 2");
  },
);
