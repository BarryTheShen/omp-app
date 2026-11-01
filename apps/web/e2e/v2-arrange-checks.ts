import type { Locator, Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * Arranging the new UI's windows on real omp: a chat dragged from the list lands on the docking guide it is dropped on
 * (#2771: a pane's arrow splits it on that side, its middle guide shows the chat in its place, the window's edge guide
 * makes a column the whole height of the window, for a pane dragged by its title too), nowhere else, and a chat open
 * already moves there; the side panel is a pane at the right of the chats, its divider resizes it and a reload keeps its
 * width. In Chromium and in WebKit, the desktop window's engine.
 */
const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });
const row = (page: Page, n: number) =>
  chats(page).getByRole("button", { name: new RegExp(`^Seeded chat ${n}\\b`) });
const boxes = (page: Page) => page.getByRole("textbox", { name: "Message" });
/** A pane, by the title its header shows. */
const pane = (page: Page, title: string) =>
  page.locator(".dv-groupview").filter({ has: page.locator(".dv-tab", { hasText: title }) });
const sidePanel = (page: Page) => page.getByRole("complementary", { name: "Side panel" });
const railButton = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Side panel" }).getByRole("button", { name });

/** Drags with the pointer from a chat's row to a point, as a person would. */
async function dragTo(page: Page, source: Locator, point: { x: number; y: number }) {
  await source.hover();
  await page.mouse.down();
  await page.mouse.move(point.x, point.y, { steps: 15 });
  await page.mouse.up();
}

/** Drags with the pointer from a chat's row to a point of an element, given as fractions of its box. */
async function dragOnto(page: Page, source: Locator, target: Locator, fx: number, fy: number) {
  const box = await place(target);
  await dragTo(page, source, { x: box.x + box.width * fx, y: box.y + box.height * fy });
}

const place = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("no box");
  return box;
};

/** The tab shown now: dockview's whole layout, whose edges hold the window's guides. */
const shownTab = (page: Page) => page.locator("[data-tab]:not([hidden])");

/** A pane's guide: around the middle of its content (where dockview takes a drop on it), one guide step (40 px) apart. */
async function guide(target: Locator, side: "top" | "bottom" | "left" | "right" | "center") {
  const area = await place(target.locator(".dv-content-container"));
  const dx = side === "right" ? 40 : side === "left" ? -40 : 0;
  const dy = side === "bottom" ? 40 : side === "top" ? -40 : 0;
  return { x: area.x + area.width / 2 + dx, y: area.y + area.height / 2 + dy };
}

/** One of the window's side guides: 12 px in from that edge, half way down. */
async function edgeGuide(page: Page, side: "left" | "right") {
  const tab = await place(shownTab(page));
  const inset = 12 + 18;
  return {
    x: side === "left" ? tab.x + inset : tab.x + tab.width - inset,
    y: tab.y + tab.height / 2,
  };
}

/** The arranging checks in one engine: Chromium, or WebKit (the desktop window's), each from its own spec file. */
export function defineArrangeChecks(engine: "chromium" | "webkit"): void {
  realTest.describe(
    `new UI arranging windows in ${engine === "webkit" ? "WebKit" : "Chromium"}`,
    () => {
      realTest.setTimeout(240_000);
      realTest.use({ seedSessions: 4 });

      realTest(
        "a chat dragged from the list lands on the guide it is dropped on, nowhere else, and one open already moves there",
        async ({ realApp }) => {
          const page = await realApp.open({ path: "/" });
          await row(page, 1).click();
          await expect(boxes(page)).toHaveAttribute("placeholder", "Message omp", {
            timeout: 120_000,
          });

          // A pane's right arrow, lit while the chat is over it: the chat opens at the right of it.
          await row(page, 2).hover();
          await page.mouse.down();
          const right = await guide(pane(page, "Seeded chat 1"), "right");
          await page.mouse.move(right.x, right.y, { steps: 15 });
          await expect(page.locator('[data-drop-guide="pane-right"][data-lit]')).toBeVisible();
          await page.mouse.up();
          await expect(boxes(page)).toHaveCount(2, { timeout: 30_000 });
          await expect
            .poll(async () => (await place(pane(page, "Seeded chat 2"))).x)
            .toBeGreaterThan((await place(pane(page, "Seeded chat 1"))).x);

          // Its bottom arrow: below it.
          await dragTo(page, row(page, 3), await guide(pane(page, "Seeded chat 1"), "bottom"));
          await expect(boxes(page)).toHaveCount(3, { timeout: 30_000 });
          await expect
            .poll(async () => (await place(pane(page, "Seeded chat 3"))).y)
            .toBeGreaterThan((await place(pane(page, "Seeded chat 1"))).y);

          // A pane's middle guide: the chat takes that pane's place.
          const third = await place(pane(page, "Seeded chat 3"));
          await dragTo(page, row(page, 4), await guide(pane(page, "Seeded chat 3"), "center"));
          await expect(pane(page, "Seeded chat 4")).toHaveCount(1, { timeout: 30_000 });
          await expect(pane(page, "Seeded chat 3")).toHaveCount(0);
          await expect(boxes(page)).toHaveCount(3);
          const fourth = await place(pane(page, "Seeded chat 4"));
          expect([Math.round(fourth.x), Math.round(fourth.y)]).toEqual([
            Math.round(third.x),
            Math.round(third.y),
          ]);

          // A chat open already moves to where it is dropped: no second pane of it.
          await dragTo(page, row(page, 2), await guide(pane(page, "Seeded chat 4"), "right"));
          await expect
            .poll(async () => (await place(pane(page, "Seeded chat 2"))).y)
            .toBe((await place(pane(page, "Seeded chat 4"))).y);
          await expect(boxes(page)).toHaveCount(3);

          // Off the guides nothing happens: a pane's old edge zone is no target now.
          await dragOnto(page, row(page, 3), pane(page, "Seeded chat 1"), 0.95, 0.5);
          await page.waitForTimeout(500);
          await expect(boxes(page)).toHaveCount(3);
          await expect(pane(page, "Seeded chat 3")).toHaveCount(0);

          // The window's left guide, lit with the strip it gives shaded while the chat is over it: a column the whole
          // height of the window, at its left. (Here it falls on the divider between the two rows.)
          await row(page, 3).hover();
          await page.mouse.down();
          const left = await edgeGuide(page, "left");
          await page.mouse.move(left.x, left.y, { steps: 15 });
          await expect(page.locator('[data-drop-guide="edge-left"][data-lit]')).toBeVisible();
          await expect(page.locator('[data-drop-shade="left"]')).toBeVisible();
          await page.mouse.up();
          await expect(boxes(page)).toHaveCount(4, { timeout: 30_000 });
          const whole = await place(shownTab(page));
          const column = await place(pane(page, "Seeded chat 3"));
          expect(Math.round(column.x)).toBe(Math.round(whole.x));
          expect(Math.abs(column.height - whole.height)).toBeLessThan(6);

          // A pane dragged by its title onto the window's right guide: a column the whole height of the window, at its right.
          await dragTo(
            page,
            pane(page, "Seeded chat 2").locator(".dv-tab"),
            await edgeGuide(page, "right"),
          );
          await expect
            .poll(async () => {
              const moved = await place(pane(page, "Seeded chat 2"));
              return [Math.round(moved.x + moved.width), Math.abs(moved.height - whole.height) < 6];
            })
            .toEqual([Math.round(whole.x + whole.width), true]);
          await expect(boxes(page)).toHaveCount(4);

          expect(realApp.problems).toEqual([]);
        },
      );

      realTest(
        "the side panel opens as a pane at the right; its divider resizes it, and a reload keeps its width",
        async ({ realApp }) => {
          const page = await realApp.open({ path: "/" });
          await row(page, 1).click();
          await expect(boxes(page)).toHaveAttribute("placeholder", "Message omp", {
            timeout: 120_000,
          });

          await railButton(page, "Usage").click();
          await expect(sidePanel(page).getByRole("tabpanel", { name: "Usage" })).toBeVisible();
          const chat = await place(pane(page, "Seeded chat 1"));
          const opened = await place(pane(page, "Usage"));
          expect(opened.x).toBeGreaterThan(chat.x);
          expect(opened.width).toBeGreaterThan(280);
          expect(opened.width).toBeLessThan(360);

          // The divider between the chat and the side panel, dragged 120 px to the left.
          const divider = { x: opened.x, y: opened.y + opened.height / 2 };
          await page.mouse.move(divider.x, divider.y);
          await page.mouse.down();
          await page.mouse.move(divider.x - 120, divider.y, { steps: 8 });
          await page.mouse.up();
          await expect
            .poll(async () => Math.round((await place(pane(page, "Usage"))).width))
            .toBeGreaterThan(Math.round(opened.width) + 100);
          const resized = Math.round((await place(pane(page, "Usage"))).width);

          await page.reload();
          await expect(sidePanel(page).getByRole("tabpanel", { name: "Usage" })).toBeVisible({
            timeout: 60_000,
          });
          await expect(railButton(page, "Usage")).toHaveAttribute("aria-pressed", "true");
          await expect
            .poll(async () => Math.round((await place(pane(page, "Usage"))).width))
            .toBeGreaterThan(resized - 4);
          expect(Math.round((await place(pane(page, "Usage"))).width)).toBeLessThan(resized + 4);

          await railButton(page, "Usage").click();
          await expect(sidePanel(page)).toHaveCount(0);

          expect(realApp.problems).toEqual([]);
        },
      );
    },
  );
}
