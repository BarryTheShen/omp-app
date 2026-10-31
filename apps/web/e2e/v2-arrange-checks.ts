import type { Locator, Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * Arranging the new UI's windows on real omp: a chat dragged from the list splits where it is dropped (a pane's edge,
 * its middle, its message box), and a chat open already moves there; the side panel is a pane at the right of the
 * chats, its divider resizes it and a reload keeps its width. In Chromium and in WebKit, the desktop window's engine,
 * where a drop on the message box was lost.
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

/** Drags with the pointer from a chat's row to a point of an element, as a person would. */
async function dragOnto(page: Page, source: Locator, target: Locator, fx: number, fy: number) {
  const box = await target.boundingBox();
  if (box === null) throw new Error("the drop target has no box");
  await source.hover();
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 15 });
  await page.mouse.up();
}

const place = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("no box");
  return box;
};

/** The message box drawn over a pane: dockview draws a pane's content in an overlay, outside the pane's element. */
async function messageBoxOver(page: Page, title: string): Promise<Locator> {
  const area = await place(pane(page, title));
  const all = boxes(page);
  for (let index = 0; index < (await all.count()); index += 1) {
    const box = await place(all.nth(index));
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    if (x > area.x && x < area.x + area.width && y > area.y && y < area.y + area.height)
      return all.nth(index);
  }
  throw new Error(`no message box over the pane of ${title}`);
}

/** The arranging checks in one engine: Chromium, or WebKit (the desktop window's), each from its own spec file. */
export function defineArrangeChecks(engine: "chromium" | "webkit"): void {
  realTest.describe(
    `new UI arranging windows in ${engine === "webkit" ? "WebKit" : "Chromium"}`,
    () => {
      realTest.setTimeout(240_000);
      realTest.use({ seedSessions: 4 });

      realTest(
        "a chat dragged from the list splits where it is dropped, and one open already moves there",
        async ({ realApp }) => {
          const page = await realApp.open({ path: "/" });
          await row(page, 1).click();
          await expect(boxes(page)).toHaveAttribute("placeholder", "Message omp", {
            timeout: 120_000,
          });

          // A pane's right edge: the chat opens at the right of it.
          await dragOnto(page, row(page, 2), page.locator(".dv-groupview").first(), 0.95, 0.5);
          await expect(boxes(page)).toHaveCount(2, { timeout: 30_000 });
          await expect
            .poll(async () => (await place(pane(page, "Seeded chat 2"))).x)
            .toBeGreaterThan((await place(pane(page, "Seeded chat 1"))).x);

          // Its middle: beside it, between it and the next pane.
          await dragOnto(page, row(page, 3), pane(page, "Seeded chat 1"), 0.5, 0.5);
          await expect(boxes(page)).toHaveCount(3, { timeout: 30_000 });
          await expect
            .poll(async () => (await place(pane(page, "Seeded chat 3"))).x)
            .toBeGreaterThan((await place(pane(page, "Seeded chat 1"))).x);
          expect((await place(pane(page, "Seeded chat 3"))).x).toBeLessThan(
            (await place(pane(page, "Seeded chat 2"))).x,
          );

          // Its message box, at the bottom of the pane: the chat opens below it.
          await dragOnto(page, row(page, 4), await messageBoxOver(page, "Seeded chat 1"), 0.5, 0.5);
          await expect(boxes(page)).toHaveCount(4, { timeout: 30_000 });
          await expect
            .poll(async () => (await place(pane(page, "Seeded chat 4"))).y)
            .toBeGreaterThan((await place(pane(page, "Seeded chat 1"))).y);

          // A chat open already moves to where it is dropped: no second pane of it.
          await dragOnto(page, row(page, 2), pane(page, "Seeded chat 4"), 0.95, 0.5);
          await expect
            .poll(async () => (await place(pane(page, "Seeded chat 2"))).y)
            .toBe((await place(pane(page, "Seeded chat 4"))).y);
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
