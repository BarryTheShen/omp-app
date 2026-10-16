import type { Page } from "@playwright/test";
import {
  expect,
  type RealApp,
  realTest,
  screenshots,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

interface CaptureMode {
  readonly name: "light" | "dark" | "390";
  readonly dark: boolean;
  readonly narrow: boolean;
}

async function expectStylesLoaded(page: Page): Promise<void> {
  const styles = await page.locator("[data-shell-layout]").evaluate((shell) => ({
    background: getComputedStyle(shell).backgroundColor,
    token: getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
  }));
  expect(styles.token).not.toBe("");
  expect(styles.background).not.toBe("rgba(0, 0, 0, 0)");
}

async function captureSharedBlocks(realApp: RealApp, mode: CaptureMode): Promise<void> {
  const page = await realApp.open({
    beforeLoad: async (target) => {
      if (mode.dark) await target.emulateMedia({ colorScheme: "dark" });
    },
  });
  try {
    await expect(page.getByText("Ready when you are", { exact: true })).toBeVisible();
    await expectStylesLoaded(page);
    if (mode.narrow) await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: `${screenshots}/fix-1301-empty-${mode.name}.png` });
    if (mode.narrow) await page.setViewportSize({ width: 1280, height: 844 });

    const composer = await startChat(page);
    if (mode.narrow) await page.setViewportSize({ width: 390, height: 844 });
    await composer.focus();
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await palette
      .getByRole("combobox", { name: "Search commands" })
      .fill("refresh model connection");
    await page.getByRole("option", { name: /Refresh model connection/ }).click();
    const question = page.getByRole("dialog");
    await expect(question).toContainText("Start a fresh connection to the model?");
    await question.getByRole("button", { name: "Confirm" }).click();
    const commandNotice = page.getByRole("status").filter({ hasText: /^omp: / });
    await expect(commandNotice).toBeVisible({ timeout: 30_000 });
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: `${screenshots}/fix-1301-command-${mode.name}.png` });
    if (mode.narrow) {
      await page.getByRole("button", { name: "Show sessions sidebar" }).click();
      await waitForFiniteAnimations(page);
    }
    const folder = page.getByRole("combobox", { name: "Workspace folder" });
    await folder.selectOption("__other__");
    await page
      .getByRole("textbox", { name: "Other folder path" })
      .fill("/no/such/folder/omp-app-review");
    await page.getByRole("button", { name: "Use", exact: true }).click();
    const folderError = page.locator("[data-app-folder-switcher]").getByRole("alert");
    await expect(folderError).toBeVisible();
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: `${screenshots}/fix-1301-folder-error-${mode.name}.png` });
  } finally {
    await page.close();
  }
}

realTest.setTimeout(240_000);

realTest(
  "issue 1301 shared blocks: empty chat, command notice and folder error in light",
  async ({ realApp }) => {
    await captureSharedBlocks(realApp, { name: "light", dark: false, narrow: false });
  },
);

realTest(
  "issue 1301 shared blocks: empty chat, command notice and folder error in dark",
  async ({ realApp }) => {
    await captureSharedBlocks(realApp, { name: "dark", dark: true, narrow: false });
  },
);

realTest(
  "issue 1301 shared blocks: empty chat, command notice and folder error at 390 px",
  async ({ realApp }) => {
    await captureSharedBlocks(realApp, { name: "390", dark: false, narrow: true });
  },
);
