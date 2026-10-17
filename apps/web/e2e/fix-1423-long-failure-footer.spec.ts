import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

realTest(
  "a long provider failure keeps its retry action visible and failure details keyboard-accessible",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await page.setViewportSize({ width: 640, height: 450 });
    await sendPrompt(composer, "runtime_failure_long: fail after a partial answer");

    const banner = page.locator('[data-slot="u1-thread-error"]');
    await expect(banner).toBeVisible({ timeout: 60_000 });
    const detail = page.getByRole("region", { name: "Failure details" });
    await expect(detail).toContainText("The fake provider rejected this request.");
    await expect(detail).toHaveAttribute("tabindex", "0");
    await expect(detail).toHaveAttribute("id", "failure-details");
    await detail.focus();
    await expect(detail).toBeFocused();
    await expect(banner.getByRole("alert")).toHaveAttribute("aria-describedby", "failure-details");
    await expect(page.getByRole("button", { name: "Regenerate response" })).toBeInViewport();
    await expect(composer).toBeInViewport();
    await expect
      .poll(() => detail.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    const beforeArrow = await detail.evaluate((element) => element.scrollTop);
    await detail.press("ArrowDown");
    await expect
      .poll(() => detail.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(beforeArrow);
    const card = await banner.boundingBox();
    if (card === null) throw new Error("Failure notice was not laid out");
    expect(card.height).toBeLessThanOrEqual(0.4 * (await page.evaluate(() => window.innerHeight)));

    await expect(banner).toHaveCSS("border-top-width", "1px");
    await expect(banner).toHaveCSS("background-color", /^(rgb|oklch)/);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1423-failure-footer-light.png"),
      fullPage: true,
    });

    const darkPage = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(darkPage.locator("html")).toHaveClass(/dark/);
    const darkComposer = await startChat(darkPage);
    await darkPage.setViewportSize({ width: 640, height: 450 });
    await sendPrompt(darkComposer, "runtime_failure_long: fail after a partial answer");
    const darkBanner = darkPage.locator('[data-slot="u1-thread-error"]');
    await expect(darkBanner).toBeVisible({ timeout: 60_000 });
    await expect(darkPage.getByRole("region", { name: "Failure details" })).toContainText(
      "The fake provider rejected this request.",
    );
    await expect(darkPage.getByRole("button", { name: "Regenerate response" })).toBeInViewport();
    await expect(darkComposer).toBeInViewport();
    await expect(darkBanner).toHaveCSS("border-top-width", "1px");
    await expect(darkBanner).toHaveCSS("background-color", /^(rgb|oklch)/);
    await waitForFiniteAnimations(darkPage);
    await darkPage.screenshot({
      path: join(screenshots, "fix-1423-failure-footer-dark.png"),
      fullPage: true,
    });
    await darkPage.close();

    await page.setViewportSize({ width: 390, height: 450 });
    await expect(banner).toBeVisible();
    await expect(page.getByRole("button", { name: "Regenerate response" })).toBeVisible();
    await expect(composer).toBeInViewport();
    await expectNoHorizontalOverflow(page);
    await expect(banner).toHaveCSS("border-top-width", "1px");
    await expect(banner).toHaveCSS("background-color", /^(rgb|oklch)/);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1423-failure-footer-390.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a long refused-key message stays in scrollable details without hiding the composer",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await page.setViewportSize({ width: 640, height: 450 });
    await sendPrompt(composer, "auth_probe_long: answer with a refused key");

    const notice = page.getByText("The model could not sign in");
    await expect(notice).toBeVisible({ timeout: 60_000 });
    await page.getByText("Show details").click();
    const details = page.locator("pre").filter({ hasText: "Invalid API key." });
    await expect(details).toBeVisible();
    expect((await details.textContent())?.length ?? 0).toBeGreaterThan(2_000);
    await expect
      .poll(() => details.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    await expect(composer).toBeInViewport();
    await expect(page.getByRole("button", { name: "Choose another model" })).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}
