import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 2175, S3: omp's `/` list holds more commands than its box shows. The arrow keys moved the highlight out of the
 * box, so the command Enter would choose could not be seen. An arrow key now scrolls the highlighted command into view.
 * A pointer move over a row moves the highlight too, and it never scrolls the list. Real omp 18.12.2 on the test machine.
 */

/** The slash list above the composer (`trigger-slot.tsx`). */
function commandList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Slash commands" });
}

/** The id of the highlighted command, as the list publishes it (`aria-activedescendant`). */
async function highlighted(page: Page): Promise<string | null> {
  const id = await commandList(page).getAttribute("aria-activedescendant");
  return id;
}

/** Whether the highlighted command lies inside the list's visible area, to within a pixel. */
async function highlightedInside(page: Page): Promise<boolean> {
  const inside = await page.evaluate(() => {
    const listbox = document.querySelector('[role="listbox"][aria-label="Slash commands"]');
    const id = listbox?.getAttribute("aria-activedescendant") ?? null;
    const row = id === null ? null : document.getElementById(id);
    const box = listbox?.querySelector("div.overflow-y-auto");
    if (!row || !box) return false;
    const top = box.getBoundingClientRect().top + box.clientTop;
    const bottom = top + box.clientHeight;
    const rect = row.getBoundingClientRect();
    return rect.top >= top - 1 && rect.bottom <= bottom + 1;
  });
  return inside;
}

/** The scroll position of the list's own box. */
async function boxScrollTop(page: Page): Promise<number> {
  const top = await page.evaluate(() => {
    const box = document.querySelector(
      '[role="listbox"][aria-label="Slash commands"] div.overflow-y-auto',
    );
    return box ? box.scrollTop : -1;
  });
  return top;
}

/**
 * The scroll position of the window and of every element on the page, the list's box left out. A list that scrolls must
 * not move the page or the conversation behind it.
 */
async function otherScrolls(page: Page): Promise<number[]> {
  const positions = await page.evaluate(() => {
    const box = document.querySelector(
      '[role="listbox"][aria-label="Slash commands"] div.overflow-y-auto',
    );
    const elements = Array.from(document.querySelectorAll("*"));
    return [
      window.scrollY,
      ...elements.map((element) => (element === box ? -1 : element.scrollTop)),
    ];
  });
  return positions;
}

realTest(
  "Down moves the highlight through the list and each command stays inside the box; Up walks back and wraps to the last",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.pressSequentially("/");
    const options = commandList(page).getByRole("option");
    await expect(options.nth(9)).toBeAttached({ timeout: 60_000 });
    const before = await otherScrolls(page);
    for (let press = 1; press <= 14; press++) {
      const previous = await highlighted(page);
      await composer.press("ArrowDown");
      await expect.poll(() => highlighted(page)).not.toBe(previous);
      expect(await highlightedInside(page), `Down press ${press}`).toBe(true);
    }
    for (let press = 1; press <= 14; press++) {
      const previous = await highlighted(page);
      await composer.press("ArrowUp");
      await expect.poll(() => highlighted(page)).not.toBe(previous);
    }
    expect(await highlighted(page)).toBe(await options.nth(0).getAttribute("id"));
    expect(await highlightedInside(page), "back on the first command").toBe(true);
    await composer.press("ArrowUp");
    await expect.poll(() => highlighted(page)).toBe(await options.last().getAttribute("id"));
    expect(await highlightedInside(page), "wrapped to the last command").toBe(true);
    expect(await otherScrolls(page)).toEqual(before);
  },
);

realTest(
  "Enter chooses the highlighted command after the arrow keys scrolled it into view, and inserts its name without sending",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.pressSequentially("/");
    const options = commandList(page).getByRole("option");
    await expect(options.nth(9)).toBeAttached({ timeout: 60_000 });
    // The first command from the tenth on that takes arguments: Enter inserts its name and waits for the arguments.
    const texts = await options.evaluateAll((rows) => rows.map((row) => row.textContent ?? ""));
    const index = texts.findIndex(
      (text, position) => position >= 9 && /Arguments|Takes arguments/.test(text),
    );
    expect(index, "a command from the tenth on takes arguments").toBeGreaterThanOrEqual(9);
    for (let press = 0; press < index; press++) await composer.press("ArrowDown");
    await expect.poll(() => highlighted(page)).toBe(await options.nth(index).getAttribute("id"));
    expect(await highlightedInside(page), "the chosen command is in view").toBe(true);
    const name = (await options.nth(index).locator("span.font-medium").textContent())?.trim() ?? "";
    await composer.press("Enter");
    await expect(composer).toHaveValue(`${name} `);
    await expect(page.getByRole("region", { name: "Command output" })).toHaveCount(0);
  },
);

realTest(
  "a pointer move over a command moves the highlight, and the list does not scroll",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.pressSequentially("/");
    const options = commandList(page).getByRole("option");
    await expect(options.nth(9)).toBeAttached({ timeout: 60_000 });
    // Commands from later sources can still arrive and shift the rows; wait until the list stops changing.
    await expect
      .poll(
        async () => {
          const before = await options.count();
          await page.waitForTimeout(500);
          return before === (await options.count());
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    // Six Down presses take the highlight past the bottom of the box, so the box has scrolled.
    for (let press = 0; press < 6; press++) await composer.press("ArrowDown");
    await expect.poll(() => highlighted(page)).toBe(await options.nth(6).getAttribute("id"));
    const scrolled = await boxScrollTop(page);
    expect(scrolled, "the box scrolled to show the sixth command").toBeGreaterThan(0);
    // The first command that is fully visible in the box.
    const visible = await page.evaluate(() => {
      const listbox = document.querySelector('[role="listbox"][aria-label="Slash commands"]');
      const box = listbox?.querySelector("div.overflow-y-auto");
      if (!box) return -1;
      const top = box.getBoundingClientRect().top + box.clientTop;
      const bottom = top + box.clientHeight;
      const rows = Array.from(listbox?.querySelectorAll('[role="option"]') ?? []);
      return rows.findIndex((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top >= top && rect.bottom <= bottom;
      });
    });
    expect(visible, "a command is fully visible").toBeGreaterThanOrEqual(0);
    const target = options.nth(visible);
    const targetId = await target.getAttribute("id");
    const row = await target.boundingBox();
    expect(row, "the visible command has a box").not.toBeNull();
    await page.mouse.move(
      (row?.x ?? 0) + (row?.width ?? 0) / 2,
      (row?.y ?? 0) + (row?.height ?? 0) / 2,
    );
    await expect.poll(() => highlighted(page)).toBe(targetId);
    expect(await boxScrollTop(page), "the list did not scroll for the pointer").toBe(scrolled);
  },
);

/** The eighth command highlighted in a list that scrolls, with the highlight styled from the design tokens. */
async function eighthHighlighted(
  page: Page,
  composer: Locator,
  variant: "light" | "dark" | "narrow",
): Promise<void> {
  await composer.pressSequentially("/");
  const options = commandList(page).getByRole("option");
  await expect(options.nth(9)).toBeAttached({ timeout: 60_000 });
  for (let press = 0; press < 7; press++) await composer.press("ArrowDown");
  await expect.poll(() => highlighted(page)).toBe(await options.nth(7).getAttribute("id"));
  expect(await highlightedInside(page), "the eighth command is in view").toBe(true);
  const colors = await page.evaluate(() => {
    const listbox = document.querySelector('[role="listbox"][aria-label="Slash commands"]');
    const id = listbox?.getAttribute("aria-activedescendant") ?? null;
    const row = id === null ? null : document.getElementById(id);
    const probe = document.createElement("div");
    probe.className = "bg-muted";
    document.body.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { row: row ? getComputedStyle(row).backgroundColor : "", token };
  });
  expect(colors.token).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.row).toBe(colors.token);
  await waitForFiniteAnimations(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, `fix-2175-s3-${variant}.png`), fullPage: true });
}

realTest(
  "the eighth command is highlighted and in view, in light",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await eighthHighlighted(page, composer, "light");
  },
);

realTest(
  "the eighth command is highlighted and in view, in dark",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    const composer = await startChat(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await eighthHighlighted(page, composer, "dark");
  },
);

realTest(
  "the eighth command is highlighted and in view, at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await eighthHighlighted(page, composer, "narrow");
  },
);
