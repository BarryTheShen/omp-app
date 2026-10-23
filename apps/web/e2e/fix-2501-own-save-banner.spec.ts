import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  narrowTo,
  realTest,
  screenshots,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

// Issue #2501: with one tab open, a reload and a refused /seance must not show "The other tab changed this draft."
// The steps are the issue's: light after a reload; then dark after a reload at 1280 px, /seance refused, and /seance
// again at 390 px. This is a guard: it also passes on main, because #1952 removed the banner for these steps. The red
// proof of the fix is the unit tests in drafts.test.ts.
const REFUSAL = "/seance only runs in omp's terminal, so nothing was sent.";
const OTHER_TAB = "The other tab";

// Runs in every document before the app loads. It records whether a notice from the other tab ever appears in that
// document, so a notice that shows for a moment still fails the test.
function watchForOtherTabNotice(): void {
  Reflect.set(window, "omp-other-tab-notice-seen", false);
  const check = (): void => {
    const shown = [...document.querySelectorAll('[role="alert"]')].some((node) =>
      (node.textContent ?? "").includes("The other tab"),
    );
    if (shown) Reflect.set(window, "omp-other-tab-notice-seen", true);
  };
  new MutationObserver(check).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
  });
}

async function expectNoOtherTabNotice(page: Page): Promise<void> {
  expect(await page.evaluate(() => Reflect.get(window, "omp-other-tab-notice-seen"))).toBe(false);
  await expect(page.getByRole("alert").filter({ hasText: OTHER_TAB })).toHaveCount(0);
}

async function expectStyled(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
  await waitForFiniteAnimations(page);
}

/**
 * Types /seance and sends it as the repo's other /seance specs do: the note shows once the slash list has settled, then
 * Enter is repeated until the refusal shows in the composer. A refusal sends nothing, so a repeat is safe.
 */
async function refuseSeance(page: Page, composer: Locator): Promise<void> {
  await composer.fill("/seance");
  await expect(page.locator('[data-terminal-only-note="seance"]')).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole("listbox", { name: "Slash commands" }).getByRole("option"),
  ).toHaveCount(0);
  await expect(async () => {
    await composer.press("Enter");
    await expect(
      page.locator('[data-composer-error="true"]').filter({ hasText: REFUSAL }),
    ).toBeVisible({
      timeout: 3_000,
    });
  }).toPass({ timeout: 60_000 });
}

realTest(
  "a reload and a refused /seance show no 'other tab' notice at 1280 or 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) => target.addInitScript(watchForOtherTabNotice),
    });
    await mkdir(screenshots, { recursive: true });

    // Step 1: light theme after a reload, then New chat.
    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "light"));
    await page.reload();
    await startChat(page);
    await expectNoOtherTabNotice(page);
    await expectStyled(page);
    await page.screenshot({ path: join(screenshots, "fix-2501-light-1280.png") });

    // Step 2: dark theme after a reload at 1280 px. The composer starts empty.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
    await page.reload();
    const composer = await startChat(page);
    await expect(composer).toHaveValue("");

    // Step 3: /seance is refused at 1280 px. The refusal keeps the draft, so it is cleared before step 4.
    await refuseSeance(page, composer);
    await composer.fill("");
    await expectNoOtherTabNotice(page);
    await page.screenshot({ path: join(screenshots, "fix-2501-dark-1280.png") });

    // Step 4: /seance is refused again at 390 px. A save answers after the refusal, so give it time before judging.
    await narrowTo(page, { width: 390, height: 844 });
    await refuseSeance(page, composer);
    await page.waitForTimeout(2_000);
    await expectNoOtherTabNotice(page);
    await expectStyled(page);
    await page.screenshot({ path: join(screenshots, "fix-2501-dark-390.png") });
  },
);
