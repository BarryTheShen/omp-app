import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { REAL_TOOL_RESULTS } from "../src/registry/real-results";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1162 (the owner's feedback). Every tool call is one line by default, running or finished: its name, its target
 * and its state chip, with the body behind a click or Enter. The chat's footer has an Expand all tool calls control,
 * and Mod+O does the same thing, so one action opens every call and Collapse all tool calls folds them again. A read,
 * an edit, a bash and a failed bash are seeded from recorded results, shaped as omp sends them, and captured folded
 * and open in light, dark and at 390 px.
 */
function recorded(name: string) {
  const sample = REAL_TOOL_RESULTS.find((candidate) => candidate.name === name);
  if (sample === undefined) throw new Error(`no recorded result named "${name}"`);
  return sample;
}

const SAMPLES = [
  recorded("read: a file, with its lines"),
  recorded("edit: one file, with the old and new text"),
  recorded("bash: a short command and its output"),
  recorded("bash: a failed command with no exit code"),
];

realTest.use({ seedToolResults: { results: SAMPLES } });

realTest(
  "every call is one line; Expand all tool calls opens every call, Collapse all tool calls folds them, and Mod+O does the same",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText(`end of sample ${SAMPLES.length - 1}`)).toBeVisible({
      timeout: 120_000,
    });
    const rows = page.locator('[data-slot="u1-message-row"][data-role="assistant"]');
    await expect(rows).toHaveCount(SAMPLES.length);
    await mkdir(screenshots, { recursive: true });

    const lineOf = (index: number) =>
      rows.nth(index).locator('[data-slot="u3-tool-card-trigger"]').first();
    const bodyOf = (index: number) => rows.nth(index).locator('[data-slot="u3-tool-card-content"]');
    const expectEveryCall = async (expanded: "true" | "false") => {
      for (let index = 0; index < SAMPLES.length; index += 1) {
        await expect(lineOf(index)).toHaveAttribute("aria-expanded", expanded);
        await expect(bodyOf(index)).toHaveCount(expanded === "true" ? 1 : 0);
      }
    };
    const expandAll = page.getByRole("button", { name: "Expand all tool calls", exact: true });
    const collapseAll = page.getByRole("button", { name: "Collapse all tool calls", exact: true });

    // Every call starts as one line. Each line keeps its chip: the failed call says Error, the rest Complete.
    await expectEveryCall("false");
    await expect(lineOf(3).getByTestId("tool-state-chip-error")).toHaveText("Error");
    await expect(lineOf(0).getByTestId("tool-state-chip-success")).toHaveText("Complete");
    await expect(expandAll).toBeVisible();
    await page.screenshot({ path: join(screenshots, "fix-1162-light-folded.png") });

    // Expand all opens every call, and its body shows what omp returned.
    await expandAll.click();
    await expectEveryCall("true");
    await expect(rows.nth(2).getByTestId("u3-bash-stdout")).toContainText("procs");
    await expect(collapseAll).toBeVisible();
    await page.screenshot({ path: join(screenshots, "fix-1162-light-open.png") });

    // Collapse all folds every call again.
    await collapseAll.click();
    await expectEveryCall("false");
    await expect(expandAll).toBeVisible();

    // Mod+O does the same as the control: it opens every call, and a second press folds them.
    await page.keyboard.press("Control+o");
    await expectEveryCall("true");
    await page.keyboard.press("Control+o");
    await expectEveryCall("false");

    // Dark, open: the same open calls on the dark theme.
    await expandAll.click();
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1162-dark-open.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    // 390 px: the folded lines and the open calls both fit the narrow column.
    await page.setViewportSize({ width: 390, height: 900 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1162-narrow-open.png") });
    await collapseAll.click();
    await expectEveryCall("false");
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1162-narrow-folded.png") });
  },
);
