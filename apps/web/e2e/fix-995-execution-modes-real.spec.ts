import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * The composer's toolbar shows an "Execution modes" button, and the palette's "Execution modes" command opens the
 * same dialog. On real omp, Fast mode is asked to turn on. The e2e model belongs to no service tier family, so
 * omp answers with its own refusal (`set_fast_mode` is refused for the current model). The dialog must show that
 * answer, keep the value omp last reported (off), and leave the choices usable. At every width the thread is used
 * at, the status bar's context readout must be whole, the title must be whole, and the button must be in the
 * composer's toolbar.
 */
const OMP_ANSWER = "Fast mode is unavailable for the current model.";
/** The widths the thread is checked at: the phone width, the widths up to the narrow limit, and desktop. */
const WIDTHS = [390, 480, 600, 768, 1280] as const;

function composerOf(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message input" });
}

/** The context readout's text, for example "10 of 128k tokens". */
function readoutOf(page: Page): Locator {
  return page.getByRole("region", { name: "Context status" }).getByText(/ tokens$/);
}

/** The composer's row: the attach button, the composer toolbar, and the send button. */
function composerRowOf(page: Page): Locator {
  return page.locator('[data-layout-area="composerToolbar"]').locator("xpath=..");
}

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

/** Two frames, so the layout of a new width has settled before it is measured. */
async function settleLayout(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/**
 * Sets the width, then lists what is wrong at it: the context readout cut off (its text needs more room than
 * its box has), the title cut off, the button not in the composer's toolbar, or the page scrolling sideways.
 */
async function layoutProblems(page: Page, width: number): Promise<string[]> {
  await page.setViewportSize({ width, height: 844 });
  await settleLayout(page);
  await expect(readoutOf(page)).toBeVisible();
  const problems: string[] = [];
  const readout = await readoutOf(page).evaluate((element) => ({
    needs: element.scrollWidth,
    has: element.clientWidth,
  }));
  if (readout.needs > readout.has) {
    problems.push(
      `${width} px: the context readout needs ${readout.needs} px and has ${readout.has} px`,
    );
  }
  const titleWhole = await page
    .getByRole("heading", { level: 1, name: "omp" })
    .evaluate((element) => element.scrollWidth <= element.clientWidth);
  if (!titleWhole) problems.push(`${width} px: the title is cut off`);
  const inToolbar = await page
    .locator('[data-layout-area="composerToolbar"]')
    .getByRole("button", { name: "Execution modes" })
    .count();
  if (inToolbar !== 1) {
    problems.push(`${width} px: the execution modes button is not in the composer's toolbar`);
  }
  const scrollsSideways = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (scrollsSideways) problems.push(`${width} px: the page scrolls sideways`);
  return problems;
}

/** Asks omp to turn Fast mode on, and waits for omp's answer to appear in the dialog. */
async function askFastModeOn(dialog: Locator): Promise<void> {
  const fast = dialog.getByRole("group", { name: "Fast mode controls" });
  await fast.getByRole("button", { name: "Turn on" }).click();
  const answer = dialog.getByText(OMP_ANSWER, { exact: true });
  await expect(answer).toBeVisible({ timeout: 60_000 });
  await expect(answer).toBeInViewport();
}

/** After omp's refusal the dialog shows Off, the last value omp reported, and both choices stay usable. */
async function expectOffAndUsable(dialog: Locator): Promise<void> {
  const fast = dialog.getByRole("group", { name: "Fast mode controls" });
  await expect(fast.getByRole("button", { name: "Turn off" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(fast.getByRole("button", { name: "Turn on" })).toBeEnabled();
  await expect(fast.getByRole("button", { name: "Turn on" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
}

realTest(
  "#995: the composer's button opens the execution modes, and omp's answer to a Fast mode change is shown, in light",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = composerOf(page);
    await startChat(page);
    await composer.click();

    await page.getByRole("button", { name: "Execution modes" }).click();
    const dialog = page.getByRole("dialog", { name: "Execution modes" });
    await expect(dialog).toBeVisible();
    // omp reports Fast mode when the dialog opens: it starts off.
    await expect(
      dialog.getByRole("group", { name: "Fast mode controls" }).getByRole("button", {
        name: "Turn off",
      }),
    ).toHaveAttribute("aria-pressed", "true", { timeout: 60_000 });
    await askFastModeOn(dialog);
    await expect(
      dialog.getByText("Fast mode could not be changed.", { exact: true }),
    ).toBeVisible();
    await expectOffAndUsable(dialog);
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-995-execution-modes-light.png") });

    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
    // Focus goes back to the button that opened the dialog, as the header's model dialog does.
    await expect(page.getByRole("button", { name: "Execution modes" })).toBeFocused();
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#995: the palette opens the execution modes in dark, and omp's answer to a Fast mode change is shown",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    const composer = composerOf(page);
    await startChat(page);
    await composer.click();

    await page.keyboard.press("Control+k");
    await page.keyboard.type("execution");
    await expect(page.getByRole("option", { name: "Execution modes" })).toBeVisible();
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-995-palette-dark.png") });
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Execution modes" });
    await expect(dialog).toBeVisible();
    await askFastModeOn(dialog);
    await expectOffAndUsable(dialog);
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-995-execution-modes-dark.png") });

    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(composer).toBeFocused();
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#995: at 390, 480, 600, 768 and 1280 px the context readout and the title stay whole, and the button is in the composer's toolbar",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = composerOf(page);
    await startChat(page);
    // The readout shows once omp has reported the chat's context use, which its first answer does.
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });

    const problems: string[] = [];
    for (const width of WIDTHS) {
      problems.push(...(await layoutProblems(page, width)));
      if (width === 390) {
        await waitForFiniteAnimations(page);
        await page.screenshot({
          animations: "disabled",
          path: join(screenshots, "fix-995-app-390-light.png"),
        });
        await page.locator('[data-layout-area="statusBar"]').screenshot({
          animations: "disabled",
          path: join(screenshots, "fix-995-statusbar-390-light.png"),
        });
        await composerRowOf(page).screenshot({
          animations: "disabled",
          path: join(screenshots, "fix-995-composer-390-light.png"),
        });
      }
      if (width === 480) {
        await waitForFiniteAnimations(page);
        await page.locator('[data-layout-area="statusBar"]').screenshot({
          animations: "disabled",
          path: join(screenshots, "fix-995-statusbar-480-light.png"),
        });
      }
    }
    expect(problems).toEqual([]);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#995: at 390 px in dark, the status bar keeps its readout whole, and the composer's toolbar keeps the button",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    const composer = composerOf(page);
    await startChat(page);
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });

    const problems = await layoutProblems(page, 390);
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-995-app-390-dark.png"),
    });
    await page.locator('[data-layout-area="statusBar"]').screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-995-statusbar-390-dark.png"),
    });
    await composerRowOf(page).screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-995-composer-390-dark.png"),
    });
    expect(problems).toEqual([]);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#995: at 390 px the composer's button opens the dialog, which fits and shows omp's answer",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = composerOf(page);
    await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await composer.click();

    const button = page.getByRole("button", { name: "Execution modes" });
    await expect(button).toBeVisible();
    await button.click();
    const dialog = page.getByRole("dialog", { name: "Execution modes" });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    await askFastModeOn(dialog);
    await expectOffAndUsable(dialog);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-995-execution-modes-narrow.png") });

    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
