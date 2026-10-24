import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  narrowTo,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/*
 * Issue 2264 (part of 2175, step S3b): the slash list's box was 288 px high (`max-h-72`), so four or five commands
 * showed. It is now `max-h-[min(28rem,45dvh)]`: taller than before at 1280 x 800, never more than 45% of the window,
 * and always inside the window above the composer. A new chat puts the composer near the middle of the window, so the
 * box must fit above it there; a chat with a reply has the composer at the bottom. Real omp 18.12.2 on the test machine.
 */

/** The list box's height on main, with `max-h-72`. */
const MAIN_BOX_HEIGHT = 288;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function rectOf(locator: Locator): Promise<Rect> {
  const rect = await locator.boundingBox();
  if (rect === null) throw new Error("the element is not rendered");
  return rect;
}

/** Types `/` in the composer and waits until the list holds ten commands, so the box is full. */
async function openFullList(page: Page, composer: Locator): Promise<void> {
  await composer.click();
  await composer.pressSequentially("/");
  const options = page.getByRole("listbox", { name: "Slash commands" }).getByRole("option");
  await expect(options.nth(9)).toBeAttached({ timeout: 60_000 });
}

/** How many commands lie wholly inside the list box without scrolling. */
async function wholeRowsShown(page: Page): Promise<number> {
  const count = await page.evaluate(() => {
    const listbox = document.querySelector('[role="listbox"][aria-label="Slash commands"]');
    const scroller = listbox?.querySelector("div.overflow-y-auto");
    if (!listbox || !scroller) return 0;
    const top = scroller.getBoundingClientRect().top + scroller.clientTop;
    const bottom = top + scroller.clientHeight;
    const rows = Array.from(listbox.querySelectorAll('[role="option"]'));
    return rows.filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top >= top - 1 && rect.bottom <= bottom + 1;
    }).length;
  });
  return count;
}

/**
 * The open list lies inside the window and above the composer, the composer is on screen, and the box is at most 45%
 * of the window's height.
 */
async function expectInsideWindow(page: Page, composer: Locator): Promise<void> {
  const view = page.viewportSize();
  if (view === null) throw new Error("the page has no viewport");
  const box = await rectOf(
    page.getByRole("listbox", { name: "Slash commands" }).locator("div.overflow-y-auto"),
  );
  const field = await rectOf(composer);
  expect(box.y, "no part of the list is above the top edge").toBeGreaterThanOrEqual(0);
  expect(box.x, "the list starts inside the window").toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, "the list ends inside the window").toBeLessThanOrEqual(view.width);
  expect(box.y + box.height, "the list ends above the composer").toBeLessThanOrEqual(field.y + 1);
  expect(field.y + field.height, "the composer is on screen").toBeLessThanOrEqual(view.height);
  expect(box.height, "the list is at most 45% of the window").toBeLessThanOrEqual(
    view.height * 0.45 + 0.5,
  );
}

/** The popover colour from the design tokens is on the list box: the styles have loaded. */
async function expectPainted(page: Page): Promise<void> {
  const colors = await page.evaluate(() => {
    const box = document.querySelector(
      '[role="listbox"][aria-label="Slash commands"] div.overflow-y-auto',
    );
    const probe = document.createElement("div");
    probe.className = "bg-popover";
    document.body.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { box: box ? getComputedStyle(box).backgroundColor : "", token };
  });
  expect(colors.token).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.box).toBe(colors.token);
}

/** Saves the open list at this page's size and theme, once its styles are checked and its animations have finished. */
async function shootOpenList(page: Page, composer: Locator, name: string): Promise<void> {
  await openFullList(page, composer);
  await expectPainted(page);
  await waitForFiniteAnimations(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage: true });
}

realTest(
  "at 1280 x 800 in a new chat the list box is taller than on main, shows at least five commands whole, stays inside the window, and after ten Down presses the highlighted command is wholly inside it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChat(page);
    await openFullList(page, composer);
    await expectInsideWindow(page, composer);
    const box = await rectOf(
      page.getByRole("listbox", { name: "Slash commands" }).locator("div.overflow-y-auto"),
    );
    expect(box.height, "the list box is taller than 288 px").toBeGreaterThan(MAIN_BOX_HEIGHT);
    expect(
      await wholeRowsShown(page),
      "commands shown whole, without scrolling",
    ).toBeGreaterThanOrEqual(5);
    const list = page.getByRole("listbox", { name: "Slash commands" });
    const options = list.getByRole("option");
    for (let press = 1; press <= 10; press++) {
      const previous = await list.getAttribute("aria-activedescendant");
      await composer.press("ArrowDown");
      await expect.poll(() => list.getAttribute("aria-activedescendant")).not.toBe(previous);
    }
    expect(await list.getAttribute("aria-activedescendant")).toBe(
      await options.nth(10).getAttribute("id"),
    );
    const inside = await page.evaluate(() => {
      const listbox = document.querySelector('[role="listbox"][aria-label="Slash commands"]');
      const id = listbox?.getAttribute("aria-activedescendant") ?? null;
      const row = id === null ? null : document.getElementById(id);
      const scroller = listbox?.querySelector("div.overflow-y-auto");
      if (!row || !scroller) return false;
      const top = scroller.getBoundingClientRect().top + scroller.clientTop;
      const bottom = top + scroller.clientHeight;
      const rect = row.getBoundingClientRect();
      return rect.top >= top - 1 && rect.bottom <= bottom + 1;
    });
    expect(inside, "the tenth Down press highlights a command wholly in view").toBe(true);
  },
);

realTest(
  "at 390 x 844 in a new chat the open list stays inside the window, above the composer",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await narrowTo(page, { width: 390, height: 844 });
    await openFullList(page, composer);
    await expectInsideWindow(page, composer);
  },
);

realTest(
  "at 1280 x 600 in a new chat the open list stays inside the window, above the composer",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 600 });
    const composer = await startChat(page);
    await openFullList(page, composer);
    await expectInsideWindow(page, composer);
  },
);

realTest(
  "at 1280 x 800 in a chat with a reply, the composer is at the bottom and the open list stays inside the window",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChat(page);
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await openFullList(page, composer);
    await expectInsideWindow(page, composer);
  },
);

realTest(
  "the open list at 1280 px in light, with its styles checked before the screenshot",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChat(page);
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await shootOpenList(page, composer, "fix-2264-light-1280");
  },
);

realTest(
  "the open list at 1280 px in dark, with its styles checked before the screenshot",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChat(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await shootOpenList(page, composer, "fix-2264-dark-1280");
  },
);

realTest(
  "the open list at 390 px in light, with its styles checked before the screenshot",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await narrowTo(page, { width: 390, height: 844 });
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await shootOpenList(page, composer, "fix-2264-light-390");
  },
);

realTest(
  "the open list at 390 px in dark, with its styles checked before the screenshot",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    const composer = await startChat(page);
    await narrowTo(page, { width: 390, height: 844 });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await shootOpenList(page, composer, "fix-2264-dark-390");
  },
);
