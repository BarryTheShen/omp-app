import { mkdir, writeFile } from "node:fs/promises";
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

/** What the Provider limits section says once omp has answered: its windows, or the plain reason it could not. */
const ANSWERED =
  /% used|omp did not|omp could not|omp usage stopped|omp's usage output|omp reports no usage limits|could not be read/;

/** Opens the Usage popover on an open chat, and waits until omp has answered the limits read. */
async function openUsageWithLimits(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: /Usage/ }).click();
  const section = page.getByRole("region", { name: "Provider limits" });
  await expect(section).toBeVisible();
  // omp may take up to its 45-second deadline; the read then ends with its windows or its plain reason.
  await expect(section.getByText("Reading provider limits…")).toHaveCount(0, { timeout: 90_000 });
  await expect(section.getByText(ANSWERED).first()).toBeVisible();
  return section;
}

realTest(
  "#963: the Usage popover reads omp's provider limits, or says why it cannot",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "pong");
    await expect(page.getByText("pong").first()).toBeVisible({ timeout: 60_000 });

    const section = await openUsageWithLimits(page);
    await mkdir(screenshots, { recursive: true });
    // What omp said, as the section shows it, for the pull request.
    await writeFile(
      join(screenshots, "fix-963-limits-state.txt"),
      `${await section.innerText()}\n`,
    );
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-963-usage-light.png"),
      fullPage: true,
    });
  },
);

realTest("#963: the provider limits read in dark", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(240_000);
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  const composer = await startChat(page);
  await sendPrompt(composer, "pong");
  await expect(page.getByText("pong").first()).toBeVisible({ timeout: 60_000 });

  await openUsageWithLimits(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-963-usage-dark.png"),
    fullPage: true,
  });
});

realTest("#963: the provider limits fit at 390 px", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(420_000);
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  // The chat starts at desktop width, where the sidebar's New chat is reachable; then the page narrows.
  const composer = await startChat(page);
  await sendPrompt(composer, "pong");
  await expect(page.getByText("pong").first()).toBeVisible({ timeout: 60_000 });
  await page.setViewportSize({ width: 390, height: 844 });

  await openUsageWithLimits(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-963-usage-narrow.png"),
    fullPage: true,
  });
  // Found by its own attributes: the popup must be on screen and no wider than the 390 px page.
  const popup = page.locator('[role="dialog"][aria-label="Session usage details"]');
  await expect(popup).toBeVisible({ timeout: 10_000 });
  const box = await popup.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
});
