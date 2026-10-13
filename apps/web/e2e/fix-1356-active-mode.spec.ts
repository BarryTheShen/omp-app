import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/** The refusal omp's app gives a `!!` line: the output would go to the model, and this version cannot leave it out. */
const REFUSED =
  "Running a command without sending its output to the model is not available in this version of omp.";
const LINE = "!!echo excluded-marker-1356";
const OUTPUT = "excluded-marker-1356";

/** One of the composer's input mode buttons: Prompt, Bash or Python. */
function modeButton(page: Page, name: string): Locator {
  return page.getByRole("group", { name: "Input mode" }).getByRole("button", { name, exact: true });
}

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

/** Types a `!!` line, clicks the Bash button that is already on, and checks the line is untouched. */
async function clickActiveBash(page: Page, composer: Locator): Promise<void> {
  await composer.fill(LINE);
  await expect(modeButton(page, "Bash")).toHaveAttribute("aria-pressed", "true");
  await modeButton(page, "Bash").click();
  await expect(composer).toHaveValue(LINE);
  await expect(modeButton(page, "Bash")).toHaveAttribute("aria-pressed", "true");
}

/** Sends the line: the refusal shows, nothing runs, and the line stays in the composer. */
async function expectRefusedAndKept(page: Page, composer: Locator): Promise<void> {
  await composer.press("Enter");
  await expect(page.locator('[data-composer-error="true"]')).toHaveText(REFUSED, {
    timeout: 30_000,
  });
  await expect(composer).toHaveValue(LINE);
  await expect(page.getByText(OUTPUT, { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-slot="u1-message-row"]')).toHaveCount(0);
}

realTest(
  "#1356: clicking Bash while a `!!` line is in Bash keeps its marker, so the line is refused and nothing runs",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await clickActiveBash(page, composer);
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1356-kept-marker-light.png") });

    await expectRefusedAndKept(page, composer);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(composer).toHaveValue(LINE);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1356-kept-marker-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1356: clicking Bash while a `!!` line is in Bash keeps its marker in dark theme",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    const composer = await startChat(page);
    await clickActiveBash(page, composer);
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1356-kept-marker-dark.png") });

    await expectRefusedAndKept(page, composer);
    expect(realApp.problems).toEqual([]);
  },
);
