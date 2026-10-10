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

const CODE = "const answer = 42;";
const MESSAGE = `Here is the snippet:\n\`\`\`ts\n${CODE}\n\`\`\``;
const COPIED = `Copied "Latest code" (${CODE.length} characters).`;

/** The picker's list of copy targets, named by its title. */
function picker(page: Page): Locator {
  return page.getByRole("listbox", { name: "Copy from this chat" });
}

/** The palette opens with Ctrl+K and runs the command by its title. */
async function copyFromPalette(page: Page): Promise<void> {
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands" }).fill("copy");
  await page.getByRole("option", { name: "Copy from this chat" }).click();
  await expect(picker(page)).toBeVisible();
}

async function chooseLatestCode(page: Page): Promise<void> {
  // An option's name includes its preview ("Latest code const answer = 42;"), so match the label.
  await picker(page).getByRole("option", { name: "Latest code" }).click();
  await page.getByRole("button", { name: "Choose", exact: true }).click();
}

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

/** Sends a message with a fenced code block and waits for the reply, so the message is saved. */
async function sendCodeMessage(page: Page): Promise<Locator> {
  const composer = await startChat(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  await sendPrompt(composer, MESSAGE);
  await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 120_000 });
  return composer;
}

realTest(
  "#813: Copy from this chat in the palette copies the latest code block, and the shortcut opens the picker",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await sendCodeMessage(page);

    await copyFromPalette(page);
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-813-picker-light.png") });
    await chooseLatestCode(page);
    await expect(page.getByText(COPIED, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CODE);
    await expect(composer).toBeFocused();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-813-copied-light.png") });

    // The shortcut opens the same picker. The composer must not hold focus: Alt+C is not taken there.
    await page.getByRole("region", { name: "Conversation transcript" }).click({
      position: { x: 4, y: 4 },
    });
    await page.keyboard.press("Alt+c");
    await expect(picker(page)).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText("Nothing was copied.", { exact: true })).toBeVisible();

    // Narrow: the same copy again, from the palette, in a 390 px window.
    await page.setViewportSize({ width: 390, height: 844 });
    await copyFromPalette(page);
    await chooseLatestCode(page);
    await expect(page.getByText(COPIED, { exact: true })).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-813-copied-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("#813: the copy outcome in dark theme", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(300_000);
  await mkdir(screenshots, { recursive: true });
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  const composer = await sendCodeMessage(page);
  await copyFromPalette(page);
  await chooseLatestCode(page);
  await expect(page.getByText(COPIED, { exact: true })).toBeVisible();
  await expect(composer).toBeFocused();
  await expectStylesLoaded(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-813-copied-dark.png") });
  expect(realApp.problems).toEqual([]);
});
