import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1329 on real omp. A turn of 200 steps opens with its earlier steps folded behind one button. Opened from
 * the keyboard, "Show all 131 remaining" removes itself when it is pressed, and the focus used to fall to the page
 * body, so the next Tab started from the top of the page. Now the focus stays on the "181 earlier steps" toggle,
 * which stays mounted. The turn is the seeded session file `seedLongTurn: 200`, as in long-turn.spec.ts.
 */
realTest.use({ seedLongTurn: 200 });

realTest(
  "pressing Show all from the keyboard keeps the focus on the earlier steps toggle",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const list = page.getByRole("listbox", { name: "Session list" });
    await list.getByRole("option", { name: /Run the long job/ }).click();

    const fold = page.getByRole("button", { name: /earlier steps/ });
    await expect(fold).toHaveText("181 earlier steps", { timeout: 60_000 });
    const cards = page.locator('[data-slot="u3-bash-card"]');
    await fold.focus();
    await page.keyboard.press("Enter");
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(cards).toHaveCount(19 + 50);

    const showAll = page.getByRole("button", { name: /Show all \d+ remaining/ });
    await showAll.focus();
    await page.keyboard.press("Enter");
    await expect(cards).toHaveCount(200);
    await expect(showAll).toHaveCount(0);
    await expect(fold).toBeFocused();

    // The captures show the styled page: the toggle's type is the design's small text, `--text-sm` (tokens.css:305).
    await expect(fold).toHaveCSS("font-size", "13px");
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1329-focus-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1329-focus-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    // At 390 px both sidebars are drawers: wait until both report closed before the narrow capture.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#shell-sessions-sidebar")).toHaveAttribute("inert", "");
    await expect(page.locator("#shell-panels-sidebar")).toHaveAttribute("inert", "");
    await expect(page.locator('[data-shell-drawer-backdrop="true"]')).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await expect(fold).toBeFocused();
    await page.screenshot({ path: join(screenshots, "fix-1329-focus-narrow.png") });
  },
);
