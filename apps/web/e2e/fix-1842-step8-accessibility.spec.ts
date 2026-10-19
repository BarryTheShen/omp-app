import { expect, type Locator, type Page } from "@playwright/test";
import { realTest, sendPrompt, startChat, waitForFiniteAnimations } from "./real-omp";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const SHELL_FOCUS_ROOTS = [
  '[aria-label="Sessions"]',
  '[data-shell-region="header"]',
  '[data-shell-region="transcript"]',
  '[data-shell-region="composer"]',
  '[aria-label="Panels"]',
];

async function markFocusable(page: Page, roots: readonly string[]): Promise<number> {
  return page.evaluate(
    ({ roots, focusableSelector }) => {
      for (const element of document.querySelectorAll("[data-step8-focus-walk]")) {
        element.removeAttribute("data-step8-focus-walk");
        element.removeAttribute("data-step8-base-border");
        element.removeAttribute("data-step8-base-composer-border");
      }
      const visited = new Set<HTMLElement>();
      const controls: HTMLElement[] = [];
      for (const selector of roots) {
        for (const root of document.querySelectorAll<HTMLElement>(selector)) {
          for (const element of root.querySelectorAll<HTMLElement>(focusableSelector)) {
            if (
              visited.has(element) ||
              element.tabIndex < 0 ||
              element.matches(":disabled") ||
              element.matches('textarea[aria-label="Message input"]') ||
              element.closest("[inert]") ||
              element.closest('[aria-hidden="true"]') ||
              !element.checkVisibility() ||
              getComputedStyle(element).visibility === "hidden"
            )
              continue;
            visited.add(element);
            controls.push(element);
          }
        }
      }
      controls.forEach((element, index) => {
        element.setAttribute("data-step8-focus-walk", String(index));
        element.setAttribute("data-step8-base-border", getComputedStyle(element).borderTopColor);
        const composerCard = element.closest<HTMLElement>("[data-composer-card]");
        element.setAttribute(
          "data-step8-base-composer-border",
          composerCard ? getComputedStyle(composerCard).borderTopColor : "",
        );
      });
      return controls.length;
    },
    { roots, focusableSelector: FOCUSABLE_SELECTOR },
  );
}

async function expectFocusIndicator(control: Locator): Promise<void> {
  await expect(control).toBeFocused();
  await control.page().waitForTimeout(250);
  const indicator = await control.evaluate((element) => {
    const style = getComputedStyle(element);
    const shadow =
      style.boxShadow !== "none" &&
      style.boxShadow.split(/,(?![^(]*\))/).some((entry) => {
        const lengths = entry
          .replace(/[a-z-]+\([^)]*\)/gi, "")
          .match(/-?(?:\d+|\d*\.\d+)px/g)
          ?.map((value) => Number.parseFloat(value));
        return lengths !== undefined && lengths.length >= 4 && lengths[3] !== 0;
      });
    const composerCard = element.closest<HTMLElement>("[data-composer-card]");
    const composerBorderColor = composerCard ? getComputedStyle(composerCard).borderTopColor : null;
    return {
      tag: element.tagName,
      name: element.getAttribute("aria-label") ?? element.textContent?.trim(),
      index: element.getAttribute("data-step8-focus-walk"),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outline: style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0,
      boxShadow: style.boxShadow,
      shadow,
      borderColor: style.borderTopColor,
      baseBorderColor: element.getAttribute("data-step8-base-border"),
      border: style.borderTopColor !== element.getAttribute("data-step8-base-border"),
      composerBorderColor,
      baseComposerBorderColor: element.getAttribute("data-step8-base-composer-border"),
      composerBorder:
        composerBorderColor !== null &&
        composerBorderColor !== element.getAttribute("data-step8-base-composer-border"),
    };
  });
  expect(
    indicator.outline || indicator.shadow || indicator.border || indicator.composerBorder,
    JSON.stringify(indicator),
  ).toBe(true);
}

realTest(
  "keyboard focus walkthrough keeps a visible indicator on rail, header, thread and composer controls",
  async ({ realApp }) => {
    const page = await realApp.open();
    try {
      const composer = await startChat(page);
      await expect(page.locator('[data-empty-chat="true"]')).toBeVisible({ timeout: 60_000 });
      await page.getByRole("button", { name: "Settings", exact: true }).focus();
      const count = await markFocusable(page, SHELL_FOCUS_ROOTS);
      expect(count).toBeGreaterThan(5);
      const visited = new Set<number>();
      const firstControl = page.locator('[data-step8-focus-walk="0"]');
      await firstControl.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expectFocusIndicator(firstControl);
      visited.add(0);
      for (let attempt = 0; attempt < count * 2 && visited.size < count; attempt += 1) {
        await page.keyboard.press("Tab");
        const index = await page.evaluate(() =>
          document.activeElement instanceof HTMLElement
            ? document.activeElement.getAttribute("data-step8-focus-walk")
            : null,
        );
        if (index === null) continue;
        const number = Number(index);
        if (visited.has(number)) break;
        const control = page.locator(`[data-step8-focus-walk="${number}"]`);
        await expectFocusIndicator(control);
        visited.add(number);
      }
      const missingIndices = Array.from({ length: count }, (_, index) => index).filter(
        (index) => !visited.has(index),
      );
      const missingControls = await page.evaluate(
        (indices) =>
          indices.map((index) => {
            const element = document.querySelector<HTMLElement>(
              `[data-step8-focus-walk="${index}"]`,
            );
            return element
              ? {
                  index,
                  tag: element.tagName,
                  role: element.getAttribute("role"),
                  label: element.getAttribute("aria-label"),
                  text: element.textContent?.trim(),
                  tabIndex: element.tabIndex,
                }
              : { index, missing: true };
          }),
        missingIndices,
      );
      expect(visited.size, JSON.stringify(missingControls)).toBe(count);
      await sendPrompt(composer, "Please write a short answer for the focus walkthrough.");
      const editControl = page.getByRole("button", {
        name: "Edit an earlier message",
        exact: true,
      });
      await expect(editControl).toBeVisible({ timeout: 60_000 });
      await markFocusable(page, SHELL_FOCUS_ROOTS);
      await editControl.focus();
      await expectFocusIndicator(editControl);
      const settings = page.getByRole("button", { name: "Settings", exact: true });
      await settings.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog).toBeVisible();
      const dialogCount = await markFocusable(page, ['[role="dialog"][aria-label="Settings"]']);
      expect(dialogCount).toBeGreaterThan(2);
      const initialIndex = await page.evaluate(() =>
        document.activeElement instanceof HTMLElement
          ? document.activeElement.getAttribute("data-step8-focus-walk")
          : null,
      );
      expect(initialIndex).not.toBeNull();
      const visitedDialogControls = new Set<number>([Number(initialIndex)]);
      await expectFocusIndicator(page.locator(`[data-step8-focus-walk="${initialIndex}"]`));
      for (
        let attempt = 0;
        attempt < dialogCount * 2 && visitedDialogControls.size < dialogCount;
        attempt += 1
      ) {
        await page.keyboard.press("Tab");
        const index = await page.evaluate(() =>
          document.activeElement instanceof HTMLElement
            ? document.activeElement.getAttribute("data-step8-focus-walk")
            : null,
        );
        expect(index).not.toBeNull();
        const number = Number(index);
        if (visitedDialogControls.has(number)) break;
        const control = page.locator(`[data-step8-focus-walk="${number}"]`);
        await expectFocusIndicator(control);
        visitedDialogControls.add(number);
      }
      expect(visitedDialogControls.size).toBe(dialogCount);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    } finally {
      await page.close();
    }
  },
);

realTest(
  "reduced motion removes long animations and transitions from the app surfaces",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: async (loadedPage) => loadedPage.emulateMedia({ reducedMotion: "reduce" }),
    });
    try {
      await startChat(page);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
      await waitForFiniteAnimations(page);
      const offenders = await page.evaluate(() => {
        const roots = [
          document.querySelector('[aria-label="Sessions"]'),
          document.querySelector('[data-shell-region="header"]'),
          document.querySelector('[data-shell-region="transcript"]'),
          document.querySelector('[data-shell-region="composer"]'),
          document.querySelector('[role="dialog"]'),
        ].filter((root): root is Element => root !== null);
        return roots.flatMap((root) =>
          [root, ...root.querySelectorAll<HTMLElement>("*")].flatMap((element) => {
            const style = getComputedStyle(element);
            const animation =
              style.animationName !== "none" && Number.parseFloat(style.animationDuration) > 0.01;
            const transition =
              style.transitionProperty !== "none" &&
              style.transitionDuration.split(",").some((value) => Number.parseFloat(value) > 0.01);
            return animation || transition ? [element.tagName] : [];
          }),
        );
      });
      expect(offenders).toEqual([]);
    } finally {
      await page.close();
    }
  },
);

realTest(
  "200 percent zoom keeps the thread and composer usable without horizontal overflow",
  async ({ realApp }) => {
    const page = await realApp.open();
    try {
      const composer = await startChat(page);
      await page.setViewportSize({ width: 640, height: 400 });
      const session = await page.context().newCDPSession(page);
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: 640,
        height: 400,
        deviceScaleFactor: 2,
        mobile: false,
      });
      expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
      const input = page.getByRole("textbox", { name: "Message input" });
      await expect(input).toBeVisible();
      await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
      await sendPrompt(composer, "Zoom scroll check. ".repeat(150));
      const userMessage = page.locator('[data-slot="u1-message-row"][data-role="user"]').first();
      await expect(userMessage).toBeVisible({ timeout: 60_000 });
      const viewport = page.locator('[data-slot="u1-thread-viewport"]');
      await expect(viewport).toBeVisible();
      await expect
        .poll(() => viewport.evaluate((element) => element.scrollHeight > element.clientHeight))
        .toBe(true);
      await viewport.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(input).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        )
        .toBe(true);
    } finally {
      await page.close();
    }
  },
);
realTest("narrow sidebar drawers move and trap keyboard focus (#2108)", async ({ realApp }) => {
  const page = await realApp.open();
  try {
    await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const toggle = page.getByRole("button", { name: "Show sessions sidebar" });
    await expect(toggle).toBeVisible();
    await toggle.click();
    const sidebar = page.getByRole("navigation", { name: "Sessions" });
    await expect(sidebar).toHaveAttribute("data-open", "true");
    const close = sidebar.getByRole("button", { name: "Hide sessions sidebar" });
    await expect(close).toBeVisible();
    await expect(close).toBeFocused();
    await page.keyboard.press("Tab");
    await expect.poll(() => sidebar.locator(":focus").count()).toBeGreaterThan(0);
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => sidebar.locator(":focus").count()).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(close).toHaveCount(0);
    await expect(toggle).toBeFocused();

    await toggle.click();
    await expect(close).toBeFocused();
    await close.click();
    await expect(toggle).toBeFocused();
  } finally {
    await page.close();
  }
});
