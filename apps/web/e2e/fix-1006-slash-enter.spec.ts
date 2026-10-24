import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/** omp's slash command list above the composer. */
function commandList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Slash commands" });
}

/**
 * The message box read by its attribute, not its role: a dialog that /settings or /hotkeys opens makes the page
 * behind it inert, so the box drops out of the accessibility tree while it still holds the text.
 */
function messageBox(page: Page): Locator {
  return page.locator('textarea[aria-label="Message input"]');
}

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await settle(page);
}

/** Captures the open dialog in light, dark and at 390 px, leaving the page in light at its wide width. */
async function captureDialogThreeWays(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: join(screenshots, `${name}-light.png`) });
  await setTheme(page, true);
  await page.screenshot({ path: join(screenshots, `${name}-dark.png`) });
  await setTheme(page, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await page.screenshot({ path: join(screenshots, `${name}-narrow.png`) });
  await page.setViewportSize({ width: 1280, height: 900 });
}

realTest(
  "#1006: typing /settings and pressing Enter at once opens Settings, with no second Enter",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);

    // The Enter follows the typing at once, so it can arrive while the command list is still loading.
    await composer.pressSequentially("/settings");
    await composer.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(dialog.getByText("Composer Shape", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(messageBox(page)).toHaveValue("");
    await captureDialogThreeWays(page, "fix-1006-settings");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1006: typing /hotkeys and pressing Enter at once opens the shortcut sheet",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);

    await composer.pressSequentially("/hotkeys");
    await composer.press("Enter");

    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(messageBox(page)).toHaveValue("");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1006: clicking /settings in the command list runs it, with no Enter after the click",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);

    await composer.pressSequentially("/settings");
    await commandList(page)
      .getByRole("option", { name: /^\/settings/ })
      .click();

    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible({ timeout: 30_000 });
    await expect(messageBox(page)).toHaveValue("");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1006: a command with arguments is inserted by Enter and waits for its arguments",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);

    await composer.pressSequentially("/usage");
    await expect(commandList(page).getByRole("option", { name: /^\/usage/ })).toBeVisible({
      timeout: 30_000,
    });
    await composer.press("Enter");

    // /usage takes arguments, so the name is inserted with its trailing space and nothing is sent.
    await expect(composer).toHaveValue("/usage ");
    expect(realApp.problems).toEqual([]);
  },
);
