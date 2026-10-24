import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 2338: `/seance` only runs in omp's terminal (seance.ts has handleTui and no handle), so over RPC omp hands its text
 * to the model. The app refuses it as it refuses the other terminal-only names: the note shows omp's own description while
 * it is typed, Enter refuses it with the sentence, and nothing is sent. Real omp 18.12.2 on the test machine.
 */

const DESCRIPTION = "Consult a saved session without resuming it";
const REFUSAL = "/seance only runs in omp's terminal, so nothing was sent.";

realTest(
  "typing /seance shows omp's description, and Enter refuses it: the text is not sent to the model",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.fill("/seance");
    const note = page.locator('[data-terminal-only-note="seance"]');
    await expect(note).toBeVisible({ timeout: 60_000 });
    await expect(note).toContainText(DESCRIPTION.slice(0, 25));
    await expect(
      page.getByRole("listbox", { name: "Slash commands" }).getByRole("option"),
    ).toHaveCount(0);
    // A refusal that is not shown yet means Enter was dropped while the list settled; a repeat is safe, since a refusal sends nothing.
    await expect(async () => {
      await composer.press("Enter");
      await expect(
        page.locator('[data-composer-error="true"]').filter({ hasText: REFUSAL }),
      ).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    await expect(composer).toHaveValue("/seance");
    await expect(page.getByText("pong")).toHaveCount(0);
  },
);

realTest(
  "the /seance refusal reads in light and dark, at 1280 and 390 px, inside the screen",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(480_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "light"));
    await page.reload();
    const composer = await startChat(page);
    for (const theme of ["light", "dark"] as const) {
      if (theme === "dark") {
        // The app's own Dark choice changes the theme. A reload brought a typed draft back, and the next save then showed
        // "The other tab changed this draft." in the capture.
        await composer.fill("");
        await expect(composer).toHaveValue("");
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.getByRole("radio", { name: "Dark" }).click();
        await expect(page.locator("html")).toHaveClass(/dark/);
      } else {
        await expect(page.locator("html")).not.toHaveClass(/dark/);
      }
      for (const width of [1280, 390] as const) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await composer.fill("/seance");
        await expect(page.locator('[data-terminal-only-note="seance"]')).toBeVisible({
          timeout: 60_000,
        });
        await expect(async () => {
          await composer.press("Enter");
          await expect(
            page.locator('[data-composer-error="true"]').filter({ hasText: REFUSAL }),
          ).toBeVisible({ timeout: 3_000 });
        }).toPass({ timeout: 60_000 });
        await waitForFiniteAnimations(page);
        const error = page.locator('[data-composer-error="true"]').filter({ hasText: REFUSAL });
        const box = await error.boundingBox();
        expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: join(screenshots, `fix-2338-seance-refusal-${theme}-${width}.png`),
          fullPage: true,
        });
        // The refusal keeps the draft, so it is cleared before the next width types `/seance` again.
        await composer.fill("");
      }
    }
  },
);
