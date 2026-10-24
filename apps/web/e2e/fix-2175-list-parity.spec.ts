import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const LIST = "Slash commands";

async function captureList(
  page: Page,
  size: "desktop" | "390",
  theme: "light" | "dark",
  saveScreenshot: boolean,
): Promise<void> {
  const list = page.getByRole("listbox", { name: LIST });
  await expect(list).toBeVisible({ timeout: 30_000 });
  const description = list
    .getByRole("option")
    .filter({ hasText: "/autoresearch" })
    .locator("span.line-clamp-2");
  await expect(description).toBeVisible();
  await expect
    .poll(() => description.evaluate((element) => getComputedStyle(element).webkitLineClamp))
    .toBe("2");
  const backgrounds = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "bg-popover";
    document.body.append(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const listBox = document.querySelector('[aria-label="Slash commands"] div.bg-popover');
    const actual = listBox === null ? "" : getComputedStyle(listBox).backgroundColor;
    return { actual, expected };
  });
  expect(backgrounds.expected).not.toBe("rgba(0, 0, 0, 0)");
  expect(backgrounds.actual).toBe(backgrounds.expected);
  await waitForFiniteAnimations(page);
  if (!saveScreenshot) return;
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({
    path: join(screenshots, `fix-2175-list-${theme}-${size}.png`),
    fullPage: false,
  });
}

realTest(
  "slash list follows omp's ordering and description layout in light and dark at desktop and phone widths",
  async ({ realApp }, testInfo) => {
    const light = await realApp.open();
    await light.setViewportSize({ width: 1280, height: 900 });
    const lightComposer = await startChat(light);
    await expect(light.locator("html")).not.toHaveClass(/dark/);
    await lightComposer.fill("/");
    const list = light.getByRole("listbox", { name: LIST });
    await expect(
      list.getByRole("option").filter({ hasText: "/autoresearch" }).locator("span.line-clamp-2"),
    ).toBeVisible({ timeout: 30_000 });
    await captureList(light, "desktop", "light", testInfo.repeatEachIndex === 0);
    await light.setViewportSize({ width: 390, height: 844 });
    await captureList(light, "390", "light", testInfo.repeatEachIndex === 0);

    const dark = await realApp.open({
      beforeLoad: (page) =>
        page.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await dark.setViewportSize({ width: 1280, height: 900 });
    const darkComposer = await startChat(dark);
    await expect(dark.locator("html")).toHaveClass(/dark/);
    await darkComposer.fill("/");
    await expect(
      dark
        .getByRole("listbox", { name: LIST })
        .getByRole("option")
        .filter({ hasText: "/autoresearch" })
        .locator("span.line-clamp-2"),
    ).toBeVisible({ timeout: 30_000 });
    await captureList(dark, "desktop", "dark", testInfo.repeatEachIndex === 0);
    await dark.setViewportSize({ width: 390, height: 844 });
    await captureList(dark, "390", "dark", testInfo.repeatEachIndex === 0);

    await darkComposer.fill("/m");
    const filtered = dark.getByRole("listbox", { name: LIST });
    await expect(filtered.getByText("/model", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(filtered.getByText("/branch", { exact: true })).toHaveCount(0);
    await darkComposer.press("ArrowDown");
    await darkComposer.press("Escape");
    await expect(filtered).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
