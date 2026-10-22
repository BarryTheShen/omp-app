import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, type RealApp, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * What has keyboard focus, and whether the sessions drawer holds it. A failing check names the element focus is on,
 * so the failure message says where focus went.
 */
async function focusedElement(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return "no element";
    const drawer = document.getElementById("shell-sessions-sidebar");
    const where = drawer?.contains(active) === true ? "in the drawer" : "outside the drawer";
    const label =
      active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 40) ?? "";
    return `${active.tagName.toLowerCase()} "${label}" ${where}`;
  });
}

/** The phone layout: the app opens at 390 px wide, as a person on a phone does, in the theme given. */
function openAtPhoneWidth(realApp: RealApp, theme: "light" | "dark" = "light"): Promise<Page> {
  return realApp.open({
    beforeLoad: async (target) => {
      await target.setViewportSize({ width: 390, height: 844 });
      await target.addInitScript(
        (value) => window.localStorage.setItem("omp-app.theme", value),
        theme,
      );
    },
  });
}

/** Opens the drawer with its header toggle and waits until its first control holds focus. */
async function openDrawerByToggle(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Show sessions sidebar" }).click();
  await expect(page.locator("#shell-sessions-sidebar")).toHaveAttribute("data-open", "true");
  await expect
    .poll(() => focusedElement(page), { timeout: 5_000 })
    .toBe('button "Hide sessions sidebar" in the drawer');
}

/** Clears focus from the page, so the next key starts from the page rather than from a control. */
async function blurActive(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
}

/** The focus ring of the focused element: it must match `:focus-visible` and paint a ring or an outline. */
async function focusRing(page: Page): Promise<{ visible: boolean; detail: string }> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return { visible: false, detail: "no element" };
    const style = getComputedStyle(active);
    const paint = style.boxShadow !== "none" ? style.boxShadow : `outline ${style.outlineStyle}`;
    return { visible: active.matches(":focus-visible") && paint !== "outline none", detail: paint };
  });
}

realTest(
  "#2108: at 390 px the sessions drawer takes focus when it opens, Tab stays inside it, and Escape returns focus to its toggle",
  async ({ realApp }) => {
    const page = await openAtPhoneWidth(realApp);
    await expect(page.getByRole("button", { name: "Show sessions sidebar" })).toBeVisible();
    await openDrawerByToggle(page);

    // Tab, pressed eight times, never leaves the drawer: the page behind it is not reached.
    const trail: string[] = [];
    for (let press = 0; press < 8; press += 1) {
      await page.keyboard.press("Tab");
      trail.push(await focusedElement(page));
    }
    expect(trail.filter((where) => !where.endsWith("in the drawer"))).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(page.locator("#shell-sessions-sidebar")).toHaveAttribute("data-open", "false");
    await expect
      .poll(() => focusedElement(page), { timeout: 5_000 })
      .toBe('button "Show sessions sidebar" outside the drawer');
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#2108: a tap on the backdrop closes the sessions drawer and returns focus to its toggle",
  async ({ realApp }) => {
    const page = await openAtPhoneWidth(realApp);
    await openDrawerByToggle(page);

    // The drawer covers the left 18rem of the phone screen, so the tap lands on the page to its right.
    await page
      .locator('[data-shell-drawer-backdrop="true"]')
      .click({ position: { x: 370, y: 400 } });
    await expect(page.locator("#shell-sessions-sidebar")).toHaveAttribute("data-open", "false");
    await expect
      .poll(() => focusedElement(page), { timeout: 5_000 })
      .toBe('button "Show sessions sidebar" outside the drawer');
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#2108: focus that moves to the page behind an open sessions drawer comes back into the drawer",
  async ({ realApp }) => {
    const page = await openAtPhoneWidth(realApp);
    await openDrawerByToggle(page);

    // A control on the page behind the drawer takes focus, as a programmatic focus or a Tab through the page would.
    const behind = await page.evaluate(() => {
      const control = document.querySelector<HTMLElement>(
        "#main-content button, #main-content textarea, #main-content input, #main-content a[href]",
      );
      if (control === null) return false;
      control.focus();
      return true;
    });
    expect(behind).toBe(true);
    await expect
      .poll(() => focusedElement(page), { timeout: 5_000 })
      .toBe('button "Hide sessions sidebar" in the drawer');
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#2108: a Tab pressed with focus on the page lands in the open sessions drawer, not on the page behind it",
  async ({ realApp }) => {
    const page = await openAtPhoneWidth(realApp);
    await openDrawerByToggle(page);

    await blurActive(page);
    await page.keyboard.press("Tab");
    await expect.poll(() => focusedElement(page), { timeout: 5_000 }).toContain("in the drawer");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#2108: a click on empty space in the open sessions drawer, then Tab, keeps focus in the drawer",
  async ({ realApp }) => {
    const page = await openAtPhoneWidth(realApp);
    const drawer = page.locator("#shell-sessions-sidebar");
    await openDrawerByToggle(page);

    // The bottom edge of the drawer, below its last control: a click there lands on plain space, not on a control.
    const box = await drawer.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) return;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 12);
    await expect(drawer).toHaveAttribute("data-open", "true");
    await page.keyboard.press("Tab");
    await expect.poll(() => focusedElement(page), { timeout: 5_000 }).toContain("in the drawer");
    expect(realApp.problems).toEqual([]);
  },
);

for (const theme of ["light", "dark"] as const) {
  realTest(
    `#2108: the open sessions drawer at 390 px shows its focus ring, in ${theme}`,
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      await mkdir(screenshots, { recursive: true });
      const page = await openAtPhoneWidth(realApp, theme);
      if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
      else await expect(page.locator("html")).not.toHaveClass(/dark/);
      // The keyboard opens the drawer, so the focus it moves in is shown with its focus-visible ring.
      await blurActive(page);
      await page.keyboard.press("Control+b");
      await expect(page.locator("#shell-sessions-sidebar")).toHaveAttribute("data-open", "true");
      await expect
        .poll(() => focusedElement(page), { timeout: 5_000 })
        .toBe('button "Hide sessions sidebar" in the drawer');
      await waitForFiniteAnimations(page);
      const ring = await focusRing(page);
      expect(ring.visible, `focus ring paint: ${ring.detail}`).toBe(true);
      await page.screenshot({
        path: join(screenshots, `fix-2108-drawer-open-${theme}-390.png`),
        fullPage: true,
      });
      expect(realApp.problems).toEqual([]);
    },
  );
}

realTest(
  "#2108: after one Tab in the open sessions drawer at 390 px the focus ring moves to its next control",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await openAtPhoneWidth(realApp, "light");
    await blurActive(page);
    await page.keyboard.press("Control+b");
    await expect(page.locator("#shell-sessions-sidebar")).toHaveAttribute("data-open", "true");
    // The drawer takes its first control a frame or more after it shows: a Tab pressed before that lands on the control.
    await expect
      .poll(() => focusedElement(page), { timeout: 5_000 })
      .toBe('button "Hide sessions sidebar" in the drawer');
    await page.keyboard.press("Tab");
    await expect
      .poll(() => focusedElement(page), { timeout: 5_000 })
      .toBe('select "Workspace folder" in the drawer');
    await waitForFiniteAnimations(page);
    const ring = await focusRing(page);
    expect(ring.visible, `focus ring paint: ${ring.detail}`).toBe(true);
    await page.screenshot({
      path: join(screenshots, "fix-2108-drawer-tab-light-390.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
