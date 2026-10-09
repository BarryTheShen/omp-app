import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/** The text of the person's own sent message: the paragraph inside their bubble. */
function sentText(page: Page): Locator {
  return page
    .getByRole("region", { name: "Conversation transcript" })
    .locator('[data-message-surface="user-bubble"] p');
}

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

async function sendTwoLines(page: Page): Promise<Locator> {
  const composer = await startChat(page);
  await composer.pressSequentially("line one");
  await composer.press("Shift+Enter");
  await composer.pressSequentially("line two");
  await expect(composer).toHaveValue("line one\nline two");
  await composer.press("Enter");
  await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 120_000 });
  return sentText(page);
}

realTest(
  "#820: a line break typed with Shift+Enter is still a line break in the sent message",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const paragraph = await sendTwoLines(page);
    await expect(paragraph.locator("br")).toHaveCount(1);
    expect(await paragraph.evaluate((element) => (element as HTMLElement).innerText)).toBe(
      "line one\nline two",
    );
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-820-light.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(paragraph.locator("br")).toHaveCount(1);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-820-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("#820: the two-line message in dark theme", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(240_000);
  await mkdir(screenshots, { recursive: true });
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  const paragraph = await sendTwoLines(page);
  await expect(paragraph.locator("br")).toHaveCount(1);
  await expectStylesLoaded(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-820-dark.png") });
  expect(realApp.problems).toEqual([]);
});
