import { type Browser, expect, type Locator, type Page } from "@playwright/test";
import { type RealApp, realTest } from "./real-omp";

/**
 * The lite view keeps a computer's layout at any width (#2845): in another app's 400 px side panel on a computer (a
 * mouse as the main pointer) the chat is the full app's desktop chat, with its message box, model and plan controls,
 * attach, the `/` and `@` menus, steering while a reply runs and a plan's approval, at a computer's sizes and without
 * the phone's controls. On a phone (a touch screen as the main pointer) the lite view keeps the phone's layout.
 */

const PANEL = { width: 400, height: 800 };
const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const planChip = (page: Page, pressed: boolean) =>
  page.getByRole("button", { name: "Plan", exact: true, pressed });

/** The lite view in a computer's side panel: a 400 px window, a mouse as the main pointer. */
async function openPanel(browser: Browser, realApp: RealApp): Promise<Page> {
  const context = await browser.newContext({ viewport: PANEL });
  const page = await realApp.open({ path: "/lite", context });
  await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
  return page;
}

/** Whether a menu or a dialog lies within the panel's width. */
async function expectInPanel(element: Locator): Promise<void> {
  const place = await element.boundingBox();
  expect(place).not.toBeNull();
  if (place === null) return;
  expect(place.x).toBeGreaterThanOrEqual(0);
  expect(place.x + place.width).toBeLessThanOrEqual(PANEL.width);
}

realTest.describe("new UI lite view at a computer's layout", () => {
  realTest(
    "a computer's 400 px panel gets the desktop box, its menus and steering, at a computer's sizes",
    async ({ realApp, browser }, testInfo) => {
      testInfo.setTimeout(240_000);
      const page = await openPanel(browser, realApp);
      // The desktop box: attach, the model and plan mode in its bottom row; none of the phone's controls.
      await expect(page.getByRole("button", { name: "Attach files" })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Model: Fake Model/ })).toBeVisible();
      await expect(planChip(page, false)).toBeVisible();
      await expect(page.getByRole("button", { name: "More" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Quick prompts" })).toHaveCount(0);
      // A computer's sizes: Send and the header's buttons are not a finger's.
      expect(
        (await page.getByRole("button", { name: "Send" }).boundingBox())?.height ?? 0,
      ).toBeLessThan(40);
      // The header's New chat (by its title: a new chat's name, on the recent chats' button, says "New chat" too).
      expect((await page.getByTitle("New chat").boundingBox())?.height ?? 0).toBeLessThan(40);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        PANEL.width,
      );

      // The `/` and `@` menus open in the panel.
      await box(page).fill("/");
      const commands = page.getByRole("listbox", { name: "omp's commands" });
      await expect(commands).toBeVisible({ timeout: 30_000 });
      await expectInPanel(commands);
      await box(page).fill("@");
      const files = page.getByRole("listbox", { name: /^Files/ });
      await expect(files).toBeVisible({ timeout: 30_000 });
      await expectInPanel(files);
      await box(page).fill("");

      // While a reply runs, Enter steers it: the message reaches omp without stopping it.
      await box(page).fill("slow_tool 20");
      await box(page).press("Enter");
      const stop = page.getByRole("button", { name: "Stop" });
      await expect(stop).toBeVisible({ timeout: 60_000 });
      await box(page).fill("steer from the side panel");
      await box(page).press("Enter");
      await expect(
        page.getByRole("region", { name: "Transcript" }).getByText("steer from the side panel"),
      ).toBeVisible({ timeout: 90_000 });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "plan mode is switched on and a plan approved in the panel",
    async ({ realApp, browser }) => {
      const page = await openPanel(browser, realApp);
      await planChip(page, false).click();
      await expect(planChip(page, true)).toBeVisible({ timeout: 5_000 });
      await box(page).fill("plan_propose");
      await box(page).press("Enter");
      const review = page.getByRole("dialog", { name: "Plan ready for review" });
      await expect(review).toBeVisible({ timeout: 60_000 });
      await expectInPanel(review);
      await review.getByRole("button", { name: "Approve" }).click();
      await expect(review).toHaveCount(0);
      await expect(planChip(page, false)).toBeVisible({ timeout: 30_000 });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("a phone keeps the phone's layout", async ({ realApp, browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await realApp.open({ path: "/lite", context });
    await expect(box(page)).toHaveAttribute("placeholder", /^(Fake Model|Message omp)/, {
      timeout: 120_000,
    });
    await expect(page.getByRole("button", { name: "More" })).toBeVisible();
    await expect(planChip(page, false)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  });
});
