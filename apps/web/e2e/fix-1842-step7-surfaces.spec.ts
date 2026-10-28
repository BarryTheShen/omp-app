import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect as baseExpect, type Locator, type Page } from "@playwright/test";
import { ChatStream, settleChat } from "./n1-chat-stream";
import { realTest, screenshots, sendPrompt, waitForFiniteAnimations } from "./real-omp";

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
const TIMEOUT = 15_000;
const ACTION_OPTIONS = { timeout: TIMEOUT } as const;
const expect = baseExpect.configure({ timeout: TIMEOUT });
realTest.use({
  seedWorkspace: { files: { "src-app.ts": "export const app = true;\n" }, gitRepo: true },
});

async function openPage(
  realApp: { open: (options?: { beforeLoad?: (page: Page) => Promise<unknown> }) => Promise<Page> },
  theme: Theme,
  _viewport: (typeof VIEWPORTS)[number],
  chat?: ChatStream,
): Promise<Page> {
  const page = await realApp.open({
    beforeLoad: async (target) => {
      await target.addInitScript((initialTheme: Theme) => {
        localStorage.setItem("omp-app.theme", initialTheme);
      }, theme);
      if (chat !== undefined) await chat.route(target);
    },
  });
  await page.setViewportSize(_viewport);
  page.setDefaultTimeout(TIMEOUT);
  return page;
}

async function tokenValues(
  page: Page,
  noticeClass = "bg-muted/30",
): Promise<{
  readonly popover: string;
  readonly border: string;
  readonly muted: string;
  readonly notice: string;
}> {
  return page.evaluate((noticeClass) => {
    const probe = document.createElement("div");
    const borderProbe = document.createElement("div");
    const mutedProbe = document.createElement("div");
    const noticeProbe = document.createElement("div");
    probe.style.backgroundColor = "var(--popover)";
    mutedProbe.style.backgroundColor = "var(--muted)";
    noticeProbe.className = noticeClass;
    borderProbe.className = "border-foreground/10";
    document.body.append(probe, borderProbe, mutedProbe, noticeProbe);
    const values = {
      popover: getComputedStyle(probe).backgroundColor,
      border: getComputedStyle(borderProbe).borderTopColor,
      muted: getComputedStyle(mutedProbe).backgroundColor,
      notice: getComputedStyle(noticeProbe).backgroundColor,
    };
    probe.remove();
    borderProbe.remove();
    mutedProbe.remove();
    noticeProbe.remove();
    return values;
  }, noticeClass);
}

function expectNoVisibleShadow(shadow: string): void {
  const entries = shadow === "none" ? [] : shadow.split(/,(?![^(]*\))/);
  expect(
    entries.every((entry) => {
      const lengths = entry
        .replace(/[a-z-]+\([^)]*\)/gi, "")
        .match(/[-+]?(?:\d*\.?\d+)(?:px)?/gi)
        ?.map(Number.parseFloat);
      return (
        lengths !== undefined &&
        lengths.length > 0 &&
        lengths.slice(-4).every((value) => value === 0)
      );
    }),
  ).toBe(true);
}

async function surfaceStyle(
  _page: Page,
  locator: Locator,
): Promise<{
  readonly radius: string;
  readonly borderWidth: string;
  readonly borderColor: string;
  readonly background: string;
  readonly shadow: string;
}> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      radius: style.borderRadius,
      borderWidth: style.borderTopWidth,
      borderColor: style.borderTopColor,
      background: style.backgroundColor,
      shadow: style.boxShadow,
    };
  });
}
async function capture(
  page: Page,
  surface: string,
  theme: Theme,
  viewport: (typeof VIEWPORTS)[number],
): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(
      screenshots,
      `fix-1842-step7-${surface}-${theme}-${viewport.width === 1280 ? "1280" : "390"}.png`,
    ),
    fullPage: true,
    animations: "disabled",
  });
}

async function expectPopoverSurface(page: Page, surface: Locator): Promise<void> {
  const actual = await surfaceStyle(page, surface);
  const tokens = await tokenValues(page);
  expect(actual.radius).toBe("10px");
  expect(actual.borderWidth).toBe("1px");
  expect(actual.borderColor).toBe(tokens.border);
  expect(actual.background).toBe(tokens.popover);
  expectNoVisibleShadow(actual.shadow);
}

async function expectNotice(
  page: Page,
  notice: Locator,
  noticeClass = "bg-muted/30",
): Promise<void> {
  const actual = await surfaceStyle(page, notice);
  const tokens = await tokenValues(page);
  const toneTokens =
    noticeClass === "bg-muted/30" ? [] : [(await tokenValues(page, noticeClass)).notice];
  expect([tokens.notice, ...toneTokens]).toContain(actual.background);
  expectNoVisibleShadow(actual.shadow);
  await expect(notice).toHaveCSS("font-size", "13px");
}

async function openChat(page: Page): Promise<Locator> {
  const newChat = page.getByRole("button", { name: "New chat" }).first();
  if (page.viewportSize()?.width !== 390 && (await newChat.isVisible())) {
    await newChat.focus(ACTION_OPTIONS);
    await newChat.press("Enter", ACTION_OPTIONS);
  } else {
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await palette
      .getByRole("combobox", { name: "Search commands" })
      .fill("new chat", ACTION_OPTIONS);
    await palette.getByRole("option", { name: /New chat/ }).click(ACTION_OPTIONS);
  }
  // As `startChat`: a new chat's composer shows once its omp has started, over 30 s while many omps start at once.
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeVisible({ timeout: 120_000 });
  return composer;
}

async function expectModelPopover(
  page: Page,
  theme: Theme,
  viewport: (typeof VIEWPORTS)[number],
): Promise<Locator> {
  const composer = await openChat(page);
  await sendPrompt(composer, "ping");
  await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /Change model or thinking/ }).click(ACTION_OPTIONS);
  const model = page.getByRole("dialog", { name: "Model and thinking" });
  await expect(model).toBeVisible();
  const thinking = model.getByRole("button", { name: /^Thinking:/ });
  await thinking.click(ACTION_OPTIONS);
  const picker = page.getByRole("listbox", { name: "Thinking levels" });
  await expect(picker).toBeVisible();
  await expectPopoverSurface(page, picker);
  const item = picker
    .locator('button[role="option"]:not(:disabled)[aria-selected="false"]')
    .first();
  await expect(item).toHaveCSS("font-size", "13px", ACTION_OPTIONS);
  await expect(item).toHaveCSS("padding-block", "6px", ACTION_OPTIONS);
  await expect(item).toHaveCSS("padding-inline", "8px", ACTION_OPTIONS);
  await item.hover(ACTION_OPTIONS);
  const muted = (await tokenValues(page)).muted;
  await expect
    .poll(() => item.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe(muted);
  await item.focus(ACTION_OPTIONS);
  await expect
    .poll(() => item.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe(muted);
  await capture(page, "model", theme, viewport);
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  if ((await model.count()) > 0)
    await model.getByRole("button", { name: "Done" }).click(ACTION_OPTIONS);
  return composer;
}

async function expectTriggerMenus(
  page: Page,
  composer: Locator,
  theme: Theme,
  viewport: (typeof VIEWPORTS)[number],
): Promise<void> {
  const triggers = [
    { text: "/us", role: "Slash commands", name: /^\/usage/, surface: "slash" },
    { text: "@src", role: "File suggestions", name: /src-app\.ts/, surface: "mention" },
    { text: ":sm", role: "Emoji suggestions", name: /:smile:/, surface: "local" },
  ] as const;
  for (const trigger of triggers) {
    await composer.fill(trigger.text, ACTION_OPTIONS);
    const popup = page.getByRole("listbox", { name: trigger.role });
    await expect(popup).toBeVisible();
    // The list answers after it opens, and its box is a new element when it does: wait for the answered list's option
    // before reading the box, so the read is never of the loading box that the answer replaces.
    const item = popup.getByRole("option").filter({ hasText: trigger.name }).first();
    await expect(item).toBeVisible();
    await expectPopoverSurface(page, popup.locator("div.bg-popover").first());
    await item.hover(ACTION_OPTIONS);
    const muted = (await tokenValues(page)).muted;
    await expect
      .poll(() => item.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe(muted);
    await expect(item).toHaveCSS("font-size", "13px", ACTION_OPTIONS);
    await expect(item).toHaveCSS("padding-block", "6px", ACTION_OPTIONS);
    await expect(item).toHaveCSS("padding-inline", "8px", ACTION_OPTIONS);
    await capture(page, trigger.surface, theme, viewport);
    await composer.press("Escape", ACTION_OPTIONS);
    await expect(popup).toHaveCount(0);
  }
}

async function expectExecutionModes(
  page: Page,
  theme: Theme,
  viewport: (typeof VIEWPORTS)[number],
): Promise<void> {
  const button = page.getByRole("button", { name: "Execution modes", exact: true });
  await button.focus(ACTION_OPTIONS);
  await button.press("Enter", ACTION_OPTIONS);
  const dialog = page.locator(
    '[data-overlay-kind="modal"][role="dialog"][aria-label="Execution modes"]',
  );
  await expect(dialog).toBeVisible();
  await expectPopoverSurface(page, dialog);
  await capture(page, "execution", theme, viewport);
  await expect
    .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

async function expectUsage(
  page: Page,
  theme: Theme,
  viewport: (typeof VIEWPORTS)[number],
): Promise<void> {
  const usageButton = page.getByRole("button", { name: /Usage/ });
  await expect(usageButton).toBeVisible();
  await usageButton.click(ACTION_OPTIONS);
  const usage = page.locator('[role="dialog"][aria-label="Session usage details"]');
  await expect(usage).toBeVisible();
  await expectPopoverSurface(page, usage);
  await capture(page, "usage", theme, viewport);
  await page.keyboard.press("Escape");
  await expect(usage).toHaveCount(0);
}

async function expectPalette(
  page: Page,
  theme: Theme,
  viewport: (typeof VIEWPORTS)[number],
): Promise<void> {
  const input = page.getByRole("textbox", { name: "Message input" });
  await input.focus(ACTION_OPTIONS);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await expectPopoverSurface(page, palette);
  const title = palette.getByRole("heading", { name: "Commands", exact: true });
  await expect(title).toHaveCSS("font-size", "13px", ACTION_OPTIONS);
  await expect(title).toHaveCSS("font-weight", "500", ACTION_OPTIONS);
  await capture(page, "palette", theme, viewport);
  await palette.getByRole("combobox", { name: "Search commands" }).focus(ACTION_OPTIONS);
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
}

async function expectSettingsAndNotice(
  page: Page,
  theme: Theme,
  viewport: (typeof VIEWPORTS)[number],
): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click(ACTION_OPTIONS);
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  const dialog = page.locator('[data-overlay-kind="modal"][role="dialog"][aria-label="Settings"]');
  await expectPopoverSurface(page, dialog);
  const title = settings.getByRole("heading", { name: "Settings", exact: true });
  await expect(title).toBeVisible();
  await expect(title).toHaveCSS("font-weight", "500", ACTION_OPTIONS);
  await expect(settings.locator("header p")).toHaveCSS("font-size", "13px", ACTION_OPTIONS);
  await capture(page, "settings-appearance", theme, viewport);
  await settings.getByRole("button", { name: "Interaction", exact: true }).click(ACTION_OPTIONS);
  await expect(
    settings.getByRole("listbox", { name: "Interaction settings sections" }),
  ).toBeVisible();
  await capture(page, "settings-interaction", theme, viewport);
  const focusedClose = settings.getByRole("button", { name: "Close settings" });
  await focusedClose.focus(ACTION_OPTIONS);
  await expect(focusedClose).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette
    .getByRole("combobox", { name: "Search commands" })
    .fill("refresh model connection", ACTION_OPTIONS);
  await page.getByRole("option", { name: /Refresh model connection/ }).click(ACTION_OPTIONS);
  const confirmation = page
    .getByRole("dialog")
    .filter({ hasText: "Start a fresh connection to the model?" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Confirm" }).click(ACTION_OPTIONS);
  const notice = page.getByRole("status").filter({ hasText: /^omp: / });
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await capture(page, "notice-neutral", theme, viewport);
  await expectNotice(page, notice);
  expect((await surfaceStyle(page, notice)).borderColor).toBe((await tokenValues(page)).border);
}

async function expectN1Toast(
  realApp: { open: (options?: { beforeLoad?: (page: Page) => Promise<unknown> }) => Promise<Page> },
  theme: Theme,
  viewport: (typeof VIEWPORTS)[number],
): Promise<void> {
  const chat = new ChatStream();
  const page = await openPage(realApp, theme, viewport, chat);
  await openChat(page);
  await settleChat(chat);
  for (const [message, tone] of [
    ["Step 7 warning toast", "warning"],
    ["Step 7 error toast", "error"],
  ] as const) {
    chat.notify([message], tone);
    const toast = page
      .getByTestId("n1-notices")
      .locator('article[data-notification-placement="toast"]')
      .filter({ hasText: message });
    await expect(toast).toBeVisible();
    await expectNotice(
      page,
      toast,
      tone === "warning" ? "bg-warning-surface" : "bg-danger-surface",
    );
    await capture(page, tone === "warning" ? "notice-warning" : "notice-danger", theme, viewport);
  }
  await page.close();
}

realTest.setTimeout(240_000);

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    realTest(
      `Step 7 surfaces: ${theme} ${viewport.width}px computed values and keyboard dismissal`,
      async ({ realApp }) => {
        const page = await openPage(realApp, theme, viewport);
        const composer = await expectModelPopover(page, theme, viewport);
        await expectTriggerMenus(page, composer, theme, viewport);
        await expectExecutionModes(page, theme, viewport);
        await expectUsage(page, theme, viewport);
        await expectPalette(page, theme, viewport);
        await expectSettingsAndNotice(page, theme, viewport);
        await expectN1Toast(realApp, theme, viewport);
        expect(
          await page.locator("html").evaluate((element) => element.classList.contains("dark")),
        ).toBe(theme === "dark");
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          viewport.width,
        );
        expect(realApp.problems).toEqual([]);
      },
    );
  }
}
