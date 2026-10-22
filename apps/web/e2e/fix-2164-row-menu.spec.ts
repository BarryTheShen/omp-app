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

const CHAT_COUNT = 15;
const CHAT_PROMPT = "menu coverage chat";

realTest.setTimeout(300_000);

async function openMenuForButton(
  page: Page,
  more: Locator,
): Promise<{ label: string; menu: Locator }> {
  const label = await more.getAttribute("aria-label");
  if (label === null) throw new Error("row More actions button has no label");
  await more.click();
  const menu = page.getByRole("menu").last();
  await expect(menu).toBeVisible();
  return { label: label.replace("More actions for ", ""), menu };
}

async function checkMenuItems(page: Page, menu: Locator): Promise<void> {
  const items = await menu.getByRole("menuitem").evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const disabled = element instanceof HTMLButtonElement && element.disabled;
      return {
        disabled,
        hit: top === element || element.contains(top),
        text: element.textContent?.trim() ?? "",
      };
    }),
  );
  console.log(`PROBE2164 items=${JSON.stringify(items)}`);
  expect(items.length).toBeGreaterThan(0);
  // Pin and Archive are intentionally disabled when the host does not publish those actions.
  expect(items.filter((item) => !item.disabled).every((item) => item.hit)).toBe(true);
  const menuBox = await menu.boundingBox();
  expect(menuBox).not.toBeNull();
  if (menuBox !== null) {
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth),
    );
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerHeight),
    );
  }
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
}

type RowPosition = "top" | "middle" | "bottom" | "edge";

async function pickVisibleMoreButton(
  page: Page,
  list: Locator,
  position: RowPosition,
): Promise<Locator> {
  const label = await list.evaluate((element, requestedPosition) => {
    const listRect = element.getBoundingClientRect();
    const visible = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[aria-label^="More actions for "]'),
    )
      .map((button) => ({
        label: button.getAttribute("aria-label"),
        rect: button.getBoundingClientRect(),
      }))
      .filter(
        ({ label, rect }) =>
          label !== null && rect.bottom > listRect.top && rect.top < listRect.bottom,
      );
    if (visible.length === 0) return null;
    if (requestedPosition === "top") return visible[0]?.label ?? null;
    if (requestedPosition === "bottom") return visible.at(-1)?.label ?? null;
    if (requestedPosition === "edge")
      return visible[Math.max(0, visible.length - 2)]?.label ?? null;
    const center = (listRect.top + listRect.bottom) / 2;
    return (
      visible.reduce((best, current) =>
        Math.abs(current.rect.top + current.rect.height / 2 - center) <
        Math.abs(best.rect.top + best.rect.height / 2 - center)
          ? current
          : best,
      ).label ?? null
    );
  }, position);
  if (label === null) throw new Error(`No visible More actions button for ${position} row`);
  return page.getByRole("button", { name: label, exact: true });
}

async function inspectRows(page: Page, screenshotName: string | undefined): Promise<void> {
  const list = page.getByRole("listbox", { name: "Session list" });
  await expect(list).toBeVisible();
  const rowCount = await page.getByRole("option").count();
  expect(rowCount).toBeGreaterThanOrEqual(CHAT_COUNT);

  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.waitForTimeout(100);
  const top = await openMenuForButton(page, await pickVisibleMoreButton(page, list, "top"));
  await checkMenuItems(page, top.menu);
  await closeMenu(page);

  await list.evaluate((element) => {
    element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
  });
  await page.waitForTimeout(100);
  const middle = await openMenuForButton(page, await pickVisibleMoreButton(page, list, "middle"));
  await checkMenuItems(page, middle.menu);
  await closeMenu(page);

  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(100);
  const bottom = await openMenuForButton(page, await pickVisibleMoreButton(page, list, "bottom"));
  await checkMenuItems(page, bottom.menu);
  if (screenshotName !== undefined) {
    await page.screenshot({ path: join(screenshots, screenshotName), fullPage: true });
  }
  await closeMenu(page);

  const scrolledEdge = await openMenuForButton(
    page,
    await pickVisibleMoreButton(page, list, "edge"),
  );
  await checkMenuItems(page, scrolledEdge.menu);
  await closeMenu(page);
}

realTest(
  "the row menu stays hit-testable at every edge in light, dark and the 390 px drawer",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    for (let index = 0; index < CHAT_COUNT; index += 1) {
      const composer = await startChat(page);
      await expect(page.locator('[data-empty-chat="true"]')).toBeVisible({
        timeout: 30_000,
      });
      const prompt = `${CHAT_PROMPT} ${index}`;
      await sendPrompt(composer, prompt);
      await expect(page.getByRole("option", { name: new RegExp(`^${prompt}`) })).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
        timeout: 60_000,
      });
    }
    await waitForFiniteAnimations(page);
    await inspectRows(page, "fix-2164-row-menu-light.png");

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await inspectRows(page, "fix-2164-row-menu-dark.png");

    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    const showSessions = page.getByRole("button", { name: /^Show sessions sidebar$/i });
    if ((await showSessions.count()) > 0) await showSessions.click();
    await waitForFiniteAnimations(page);
    await expect(page.getByRole("listbox", { name: "Session list" })).toBeVisible();
    await inspectRows(page, "fix-2164-row-menu-390.png");

    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a streaming reply does not close an open running-row menu when the transcript scrolls",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "stream_long_code show the long block");
    const runningRow = page.locator('[data-slot="r1-running-row"]');
    await expect(runningRow).toBeVisible({ timeout: 60_000 });
    const more = runningRow.getByRole("button", { name: "More actions for New chat" });
    await more.click();
    const menu = runningRow.getByRole("menu", { name: "Actions for New chat" });
    await expect(menu).toBeVisible();
    await page.waitForTimeout(3_000);
    await expect(menu).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);
