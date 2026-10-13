import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { REAL_TOOL_RESULTS } from "../src/registry/real-results";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1298. A page served over plain http from another machine has no Clipboard API. "Copy raw result" on a
 * tool card copied nothing there, yet its status said "Copied raw output". Now the card says "Copy unavailable",
 * as the other copy buttons do without a clipboard, and it never says it copied. This page is opened with
 * `navigator.clipboard` removed before the app loads; the result is a recorded find call, seeded into one real chat.
 */
function recorded(name: string) {
  const sample = REAL_TOOL_RESULTS.find((candidate) => candidate.name === name);
  if (sample === undefined) throw new Error(`no recorded result named "${name}"`);
  return sample;
}

realTest.use({
  seedToolResults: { results: [recorded("find: one hit with a snippet")] },
});

realTest(
  "on a page with no clipboard, Copy raw result says Copy unavailable and never says it copied",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => {
          Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
        }),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(() => page.evaluate(() => navigator.clipboard === undefined)).toBe(true);
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("end of sample 0")).toBeVisible({ timeout: 60_000 });
    await mkdir(screenshots, { recursive: true });

    const row = page.locator('[data-slot="u1-message-row"][data-role="assistant"]').nth(0);
    const card = row.locator('[data-slot="u3-tool-card"]').first();
    const trigger = card.locator('[data-slot="u3-tool-card-trigger"]').first();
    const raw = card.locator('[data-slot="u3-tool-card-raw"]');
    const copy = card
      .locator('[data-slot="u3-tool-card-result"]')
      .getByRole("button", { name: "Copy raw result" });
    // "Copy raw result" exists once the call has finished and its result is shown, so wait for that state first.
    await expect(card).toHaveAttribute("data-phase", "success", { timeout: 30_000 });
    // Each attempt reads the card's state before it acts, and clicks only the parts that are still closed. A card
    // that renders again closes its Raw details again, so the attempt opens it again instead of waiting on it.
    await expect(async () => {
      await expect(trigger).toBeAttached({ timeout: 2_000 });
      if ((await trigger.getAttribute("aria-expanded")) !== "true") {
        await trigger.click({ timeout: 2_000 });
      }
      await expect(trigger).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 });
      await expect(raw).toBeAttached({ timeout: 2_000 });
      if ((await raw.getAttribute("open")) === null) {
        await card.getByText("Raw details", { exact: true }).click({ timeout: 2_000 });
      }
      await expect(raw).toHaveJSProperty("open", true, { timeout: 2_000 });
      // The copy does not happen here, and the card says so in plain words; it never reports a copy.
      await copy.click({ timeout: 2_000 });
      await expect(card.getByText("Copy unavailable", { exact: true })).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 90_000 });
    await expect(card.getByText("Copied raw output", { exact: true })).toHaveCount(0);
    const result = card.locator('[data-slot="u3-tool-card-result"]');

    // Each capture is taken once the app's styles have loaded: the Result block has its bordered box.
    const shownResult = result.locator("pre");
    await expect(shownResult).toHaveCSS("border-top-width", "1px");
    await card.screenshot({ path: join(screenshots, "fix-1298-copy-unavailable-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await expect(shownResult).toHaveCSS("border-top-width", "1px");
    await card.screenshot({ path: join(screenshots, "fix-1298-copy-unavailable-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 900 });
    await waitForFiniteAnimations(page);
    await expect(shownResult).toHaveCSS("border-top-width", "1px");
    await card.screenshot({ path: join(screenshots, "fix-1298-copy-unavailable-narrow.png") });
  },
);
