import type { Locator } from "@playwright/test";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

realTest.use({ seedSessions: 12 });

async function openSessions(page: Parameters<typeof startChat>[0]): Promise<void> {
  await page.getByRole("button", { name: "Show sessions sidebar" }).click();
  await expect(page.getByRole("navigation", { name: "Sessions" })).toHaveAttribute(
    "data-open",
    "true",
  );
}

type TestPage = Parameters<typeof startChat>[0];

async function focusByTab(page: TestPage, selector: string): Promise<void> {
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute("tabindex");
  });
  const target = page.locator(selector);
  for (let index = 0; index < 48; index += 1) {
    if (await target.evaluate((element) => document.activeElement === element)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Keyboard focus did not reach ${selector}`);
}

async function focusClip(page: TestPage, selector: string): Promise<number> {
  return measureFocusClip(page.locator(selector));
}

async function measureFocusClip(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const outlineWidth = Number.parseFloat(style.outlineWidth) || 0;
    const outlineOffset = Number.parseFloat(style.outlineOffset) || 0;
    const shadowSpread = Number.parseFloat(
      style.boxShadow.match(/0px 0px 0px ([\d.]+)px/)?.[1] ?? "0",
    );
    const inset = style.boxShadow.includes("inset");
    const expansion = inset
      ? 0
      : outlineWidth > 0 && style.outlineStyle !== "none"
        ? outlineWidth + outlineOffset
        : shadowSpread;
    const edge = {
      left: rect.left - expansion,
      right: rect.right + expansion,
      top: rect.top - expansion,
      bottom: rect.bottom + expansion,
    };
    let clipped = 0;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      const clipsX = ancestorStyle.overflowX !== "visible" && ancestorStyle.overflowX !== "clip";
      const clipsY = ancestorStyle.overflowY !== "visible" && ancestorStyle.overflowY !== "clip";
      if (!clipsX && !clipsY) continue;
      const ancestorRect = ancestor.getBoundingClientRect();
      if (clipsX) {
        clipped = Math.max(clipped, ancestorRect.left - edge.left, edge.right - ancestorRect.right);
      }
      if (clipsY) {
        clipped = Math.max(clipped, ancestorRect.top - edge.top, edge.bottom - ancestorRect.bottom);
      }
    }
    return Math.max(0, clipped);
  });
}

realTest("S8-05 returns focus to a row action after delete cancel", async ({ realApp }) => {
  const page = await realApp.open();
  try {
    await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSessions(page);
    const more = page.getByRole("button", { name: /More actions for/ }).first();
    await more.click();
    await page.getByRole("menuitem", { name: /Delete/ }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(more).toBeFocused();
  } finally {
    await page.close();
  }
});

realTest("S8-08 keeps the Messages focus ring inside its scroll region", async ({ realApp }) => {
  const page = await realApp.open();
  try {
    await startChat(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await focusByTab(page, '[data-slot="u1-thread-viewport"]');
    expect(await focusClip(page, '[data-slot="u1-thread-viewport"]')).toBeLessThanOrEqual(0.5);
  } finally {
    await page.close();
  }
});

realTest("S8-10 clicking a blank row area opens that chat", async ({ realApp }) => {
  const page = await realApp.open();
  try {
    await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSessions(page);
    const row = page.locator('[data-slot="r1-session-row"]:visible').nth(1);
    await expect(row).toHaveAttribute("data-selected", "false");
    const moreAction = row.getByRole("button", { name: /More actions for/ });
    const rowBox = await row.boundingBox();
    const moreBox = await moreAction.boundingBox();
    const title = row.locator('[role="option"] > div').first();
    const titleRight = await title.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rects = Array.from(range.getClientRects());
      return Math.max(...rects.map((rect) => rect.right));
    });
    if (!rowBox || !moreBox || !Number.isFinite(titleRight)) {
      throw new Error("session row title or action bounds are not drawn");
    }
    const left = titleRight + 2;
    const right = moreBox.x - 2;
    if (right <= left) throw new Error("session row has no blank area before its actions");
    const point = { x: (left + right) / 2, y: rowBox.y + rowBox.height / 2 };
    const hit = await row.evaluate((element, position) => {
      const target = document.elementFromPoint(position.x, position.y);
      return {
        inRow: target?.closest('[data-slot="r1-session-row"]') === element,
        interactive: Boolean(target?.closest("button, input, [role='menu']")),
      };
    }, point);
    expect(hit.inRow).toBe(true);
    expect(hit.interactive).toBe(false);
    await page.mouse.click(point.x, point.y);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(row).toHaveAttribute("data-selected", "true");
  } finally {
    await page.close();
  }
});

realTest("S8-11 opening New chat closes the narrow drawer", async ({ realApp }) => {
  const page = await realApp.open();
  try {
    await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const drawer = page.locator('nav[aria-label="Sessions"]');
    await openSessions(page);
    await drawer.getByRole("button", { name: "New chat" }).click();
    await expect(drawer).toHaveAttribute("data-open", "false");
  } finally {
    await page.close();
  }
});

realTest("S8-11 opening an existing chat closes the narrow drawer", async ({ realApp }) => {
  const page = await realApp.open();
  try {
    const composer = await startChat(page);
    await sendPrompt(composer, "hello there");
    await expect(
      page.locator('[data-slot="u1-message-row"][data-role="assistant"]').first(),
    ).toBeVisible({ timeout: 60_000 });
    await page.setViewportSize({ width: 390, height: 844 });
    await openSessions(page);
    const drawer = page.locator('nav[aria-label="Sessions"]');
    await expect
      .poll(async () => drawer.locator('[role="option"]:visible').count())
      .toBeGreaterThan(0);
    // The event the 1 s pause stood for: the turn has ended and the list has refreshed once no row shows a running turn.
    await expect(drawer.locator('[data-slot="r1-session-running"]:visible')).toHaveCount(0, {
      timeout: 60_000,
    });
    const option = drawer.locator('[role="option"]:visible').first();
    await expect(option).toBeVisible({ timeout: 60_000 });
    await option.focus();
    await expect(option).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(drawer).toHaveAttribute("data-open", "false");
  } finally {
    await page.close();
  }
});

realTest("S8-11 renaming a chat in the narrow drawer keeps it open", async ({ realApp }) => {
  const page = await realApp.open();
  try {
    await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSessions(page);
    const drawer = page.locator('nav[aria-label="Sessions"]');
    const row = drawer.locator('[data-slot="r1-session-row"]:visible').first();
    await row.getByRole("button", { name: /More actions for/ }).click();
    await page.getByRole("menuitem", { name: /Rename/ }).click();
    const input = row.locator('input[aria-label^="Rename "]');
    await input.fill("Two");
    await input.press("Space");
    await input.pressSequentially("word title");
    await input.press("Enter");
    await expect(row).toContainText("Two word title", { timeout: 45_000 });
    await expect(drawer).toHaveAttribute("data-open", "true");
  } finally {
    await page.close();
  }
});

realTest("S8-12 keeps the conversation header on one line at 320px", async ({ realApp }) => {
  const page = await realApp.open();
  try {
    const composer = await startChat(page);
    await sendPrompt(composer, "hello there");
    await expect(
      page.locator('[data-slot="u1-message-row"][data-role="assistant"]').first(),
    ).toBeVisible({
      timeout: 60_000,
    });
    await page.setViewportSize({ width: 320, height: 640 });
    const drawer = page.locator('nav[aria-label="Sessions"]');
    await openSessions(page);
    const selected = drawer.locator('[data-slot="r1-session-row"][data-selected="true"]');
    await selected.getByRole("button", { name: /More actions for/ }).click();
    await page.getByRole("menuitem", { name: /Rename/ }).click();
    const rename = page.locator('input[aria-label^="Rename "]').first();
    await rename.fill("A".repeat(220));
    await rename.press("Enter");
    await drawer.getByRole("button", { name: "Hide sessions sidebar" }).click();
    const header = page.locator('[data-shell-region="header"]');
    const settings = page.getByRole("button", { name: "Settings" });
    expect((await header.boundingBox())?.height).toBe(48);
    const settingsBox = await settings.boundingBox();
    expect(settingsBox).not.toBeNull();
    expect((settingsBox?.y ?? Infinity) + (settingsBox?.height ?? 0)).toBeLessThanOrEqual(48);
  } finally {
    await page.close();
  }
});

realTest("S8-13 keeps rename and last-row focus rings inset", async ({ realApp }) => {
  const page = await realApp.open();
  try {
    await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSessions(page);
    const more = page.getByRole("button", { name: /More actions for/ }).first();
    await more.click();
    await page.getByRole("menuitem", { name: /Rename/ }).click();
    const rename = page.locator('input[aria-label^="Rename "]').first();
    await expect(rename).toBeFocused();
    await rename.press("Tab");
    await page.keyboard.press("Shift+Tab");
    expect(await measureFocusClip(rename)).toBeLessThanOrEqual(0.5);
    const drawer = page.locator('nav[aria-label="Sessions"]');
    const lastOption = drawer.getByRole("option").last();
    await lastOption.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    expect(await measureFocusClip(lastOption)).toBeLessThanOrEqual(0.5);
  } finally {
    await page.close();
  }
});

realTest(
  "S8-14 exposes one Sessions landmark and a distinct session-list landmark",
  async ({ realApp }) => {
    const page = await realApp.open();
    try {
      await startChat(page);
      expect(await page.locator('nav[aria-label="Sessions"]').count()).toBe(1);
      expect(await page.locator('aside[aria-label="Session list"]').count()).toBe(1);
    } finally {
      await page.close();
    }
  },
);
