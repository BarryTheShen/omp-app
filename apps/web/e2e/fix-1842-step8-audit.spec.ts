import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;
const THEMES = ["light", "dark"] as const;

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

async function closePanels(page: Page): Promise<void> {
  const hide = page.getByRole("button", { name: "Hide panels sidebar" });
  if (await hide.count()) await hide.first().click();
}

realTest(
  "prints the document measured-value table at both audit sizes and themes",
  async ({ realApp }) => {
    const output: string[] = ["Part | Document value | Measured value | Difference"];
    for (const theme of THEMES) {
      const page = await realApp.open({
        beforeLoad: async (loadedPage) => {
          await loadedPage.addInitScript(
            (value) => window.localStorage.setItem("omp-app.theme", value),
            theme,
          );
          await loadedPage.emulateMedia({ colorScheme: theme });
        },
      });
      try {
        await startChat(page);
        await waitForFiniteAnimations(page);
        await mkdir(screenshots, { recursive: true });
        await page.screenshot({
          path: join(screenshots, `fix-1842-step8-loading-${theme}-desktop.png`),
          fullPage: true,
          animations: "disabled",
        });
        await expect(page.getByText("How can I help you today?", { exact: true })).toBeVisible({
          timeout: 60_000,
        });
        await closePanels(page);
        for (const viewport of VIEWPORTS) {
          await page.setViewportSize(viewport);
          await waitForFiniteAnimations(page);
          await mkdir(screenshots, { recursive: true });
          await page.screenshot({
            path: join(screenshots, `fix-1842-step8-empty-${theme}-${viewport.name}.png`),
            fullPage: true,
            animations: "disabled",
          });
          if (viewport.width === 390) {
            await page.getByRole("button", { name: "Show sessions sidebar" }).click();
            await waitForFiniteAnimations(page);
            await page.screenshot({
              path: join(screenshots, `fix-1842-step8-sessions-drawer-${theme}-phone.png`),
              fullPage: true,
              animations: "disabled",
            });
          }
          const metrics = await page.evaluate(() => {
            const rail = document.querySelector<HTMLElement>('[data-shell-sidebar="left"]');
            const header = document.querySelector<HTMLElement>('[data-shell-region="header"]');
            const composer = document.querySelector<HTMLElement>("[data-composer-card]");
            const main = document.querySelector<HTMLElement>('[data-shell-main="true"]');
            const greetingText = Array.from(document.querySelectorAll<HTMLElement>("p")).find(
              (element) => element.textContent?.trim() === "How can I help you today?",
            );
            const greeting =
              document.querySelector<HTMLElement>('[data-empty-chat="true"]') ??
              greetingText?.parentElement ??
              null;
            const composerInput = document.querySelector<HTMLElement>(
              '[data-shell-region="composer"] textarea',
            );
            const railHeader = rail?.firstElementChild;
            const railBody = rail?.querySelector<HTMLElement>('aside[aria-label="Session list"]');
            const brand = railHeader?.querySelector("span");
            const brandMark = railHeader?.querySelector("img");
            const title = header?.querySelector("h1");
            const newChat = Array.from(rail?.querySelectorAll("button") ?? []).find(
              (button) => button.textContent?.trim() === "New chat",
            );
            const attach = document.querySelector<HTMLElement>(
              '[data-shell-region="composer"] button[aria-label="Add attachment"]',
            );
            const send = document.querySelector<HTMLElement>(
              '[data-shell-region="composer"] button[aria-label="Send message"]',
            );
            if (
              !rail ||
              !header ||
              !composer ||
              !main ||
              !greeting ||
              !greetingText ||
              !composerInput ||
              !railHeader ||
              !railBody ||
              !brand ||
              !brandMark ||
              !title ||
              !newChat ||
              !attach ||
              !send
            ) {
              const missing = [
                !rail && "rail",
                !header && "header",
                !composer && "composer",
                !main && "main",
                !greeting && "greeting",
                !greetingText && "greeting text",
                !composerInput && "composer input",
                !railHeader && "rail header",
                !railBody && "rail body",
                !brand && "brand text",
                !brandMark && "brand mark",
                !title && "thread title",
                !newChat && "new chat button",
                !attach && "attachment button",
                !send && "send button",
              ]
                .filter((label): label is string => Boolean(label))
                .join(", ");
              throw new Error(`Audit surfaces are missing: ${missing}`);
            }
            const style = (element: Element) => {
              const box = element.getBoundingClientRect();
              const computed = getComputedStyle(element);
              return {
                width: box.width,
                height: box.height,
                paddingInline: computed.paddingInline,
                paddingBlock: computed.paddingBlock,
                fontSize: computed.fontSize,
                lineHeight: computed.lineHeight,
                fontWeight: computed.fontWeight,
                letterSpacing: computed.letterSpacing,
                borderTopWidth: computed.borderTopWidth,
                borderRightWidth: computed.borderRightWidth,
                borderBottomWidth: computed.borderBottomWidth,
                borderRadius: computed.borderRadius,
                background: computed.backgroundColor,
                borderColor: computed.borderTopColor,
              };
            };
            return {
              grid: style(main),
              rail: style(rail),
              railHeader: style(railHeader),
              railBody: style(railBody),
              brand: {
                ...style(brand),
                left: brand.getBoundingClientRect().left - rail.getBoundingClientRect().left,
              },
              brandMark: {
                ...style(brandMark),
                left: brandMark.getBoundingClientRect().left - rail.getBoundingClientRect().left,
              },
              title: style(title),
              newChat: style(newChat),
              header: style(header),
              greeting: style(greetingText),
              greetingGap:
                composer.getBoundingClientRect().top - greeting.getBoundingClientRect().bottom,
              composer: style(composer),
              composerInput: style(composerInput),
              attach: style(attach),
              send: style(send),
              overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            };
          });
          const expectedRail = viewport.width === 1280 ? 240 : 288;
          const expectedMain = viewport.width === 1280 ? 1006 : 390;
          const expectedComposer = viewport.width === 1280 ? 672 : 342;
          const expectedGreeting = viewport.width === 1280 ? 28 : 24;
          output.push(
            `Grid (${theme}, ${viewport.name}) | ${expectedMain}px wide × 48px header | ${metrics.grid.width.toFixed(0)}px × ${metrics.header.height.toFixed(0)}px | Δ ${metrics.grid.width - expectedMain}px, ${metrics.header.height - 48}px`,
          );
          output.push(
            `Rail header cell (${theme}, ${viewport.name}) | ${expectedRail}px × 48px | ${metrics.railHeader.width.toFixed(0)}px + ${metrics.rail.borderRightWidth} border × ${metrics.railHeader.height.toFixed(0)}px = ${(metrics.railHeader.width + Number.parseFloat(metrics.rail.borderRightWidth)).toFixed(0)}px overall | Δ ${metrics.railHeader.width + Number.parseFloat(metrics.rail.borderRightWidth) - expectedRail}px, ${metrics.railHeader.height - 48}px`,
          );
          output.push(
            `Rail body (${theme}, ${viewport.name}) | ${expectedRail}px overall, 12px padding, rail background, 1px right border | ${metrics.rail.width.toFixed(0)}px overall / ${metrics.railBody.width.toFixed(0)}px content, ${metrics.railBody.paddingBlock} ${metrics.railBody.paddingInline} padding, ${metrics.railBody.background}, ${metrics.rail.borderRightWidth} border | Δ ${metrics.rail.width - expectedRail}px`,
          );
          output.push(
            `Thread header (${theme}, ${viewport.name}) | 48px high, ${viewport.width === 1280 ? 20 : 16}px horizontal padding, 1px bottom border | ${metrics.header.height.toFixed(0)}px high, ${metrics.header.paddingInline} padding, ${metrics.header.borderBottomWidth} border | Δ ${metrics.header.height - 48}px`,
          );
          output.push(
            `Brand text (${theme}, ${viewport.name}) | 16px mark + 8px gap; 13px / 500 text at x=40px | mark ${metrics.brandMark.width}×${metrics.brandMark.height}px at x=${metrics.brandMark.left}px; text ${metrics.brand.fontSize} / ${metrics.brand.fontWeight} at x=${metrics.brand.left.toFixed(0)}px | Δ ${metrics.brandMark.width - 16}px, ${metrics.brand.left - metrics.brandMark.left - metrics.brandMark.width - 8}px, ${metrics.brand.left - 40}px`,
          );
          output.push(
            `Thread title (${theme}, ${viewport.name}) | 13px / 19.5px / 500 | ${metrics.title.fontSize} / ${metrics.title.lineHeight} / ${metrics.title.fontWeight} | Δ ${Number.parseFloat(metrics.title.fontSize) - 13}px`,
          );
          output.push(
            `New chat button (${theme}, ${viewport.name}) | ${viewport.width === 1280 ? "215" : "264"}px × 32px, 8px radius, 1px border, 10px left padding, 13px | ${metrics.newChat.width.toFixed(0)}px × ${metrics.newChat.height.toFixed(0)}px, ${metrics.newChat.borderRadius}, ${metrics.newChat.borderTopWidth}, ${metrics.newChat.paddingInline}, ${metrics.newChat.fontSize} | Δ ${metrics.newChat.height - 32}px`,
          );
          output.push(
            `Greeting (${theme}, ${viewport.name}) | ${expectedGreeting}px, ${viewport.width === 1280 ? "38.5" : "33"}px line, 550; 32px above card | ${metrics.greeting.fontSize}, ${metrics.greeting.lineHeight}, ${metrics.greeting.fontWeight}; gap ${metrics.greetingGap.toFixed(0)}px | Δ ${Number.parseFloat(metrics.greeting.fontSize) - expectedGreeting}px, ${metrics.greetingGap - 32}px`,
          );
          output.push(
            `Composer card (${theme}, ${viewport.name}) | ${expectedComposer}px wide, ${viewport.width === 1280 ? "82px high" : "phone height unspecified"}, 16px radius | ${metrics.composer.width.toFixed(0)}px × ${metrics.composer.height.toFixed(0)}px, ${metrics.composer.borderRadius} | Δ ${metrics.composer.width - expectedComposer}px, ${viewport.width === 1280 ? `${metrics.composer.height - 82}px` : "not specified"}`,
          );
          output.push(
            `Composer text box (${theme}, ${viewport.name}) | 16px / 24px, 12px 16px 8px padding | ${metrics.composerInput.fontSize} / ${metrics.composerInput.lineHeight}, ${metrics.composerInput.paddingBlock} ${metrics.composerInput.paddingInline} | Δ ${Number.parseFloat(metrics.composerInput.fontSize) - 16}px`,
          );
          output.push(
            `Composer buttons (${theme}, ${viewport.name}) | 28px × 28px, 8px radius | attach ${metrics.attach.width.toFixed(0)}×${metrics.attach.height.toFixed(0)}px ${metrics.attach.borderRadius}; send ${metrics.send.width.toFixed(0)}×${metrics.send.height.toFixed(0)}px ${metrics.send.borderRadius} | Δ ${metrics.attach.width - 28}px`,
          );
          expect(metrics.brandMark.width).toBe(16);
          expect(metrics.brandMark.left).toBe(16);
          expect(metrics.brand.left).toBe(40);
          expect(metrics.overflow).toBe(false);
          if (viewport.width === 390) {
            await page.getByRole("button", { name: "Hide sessions sidebar" }).click();
            await page.getByRole("button", { name: "Show panels sidebar" }).click();
            await waitForFiniteAnimations(page);
            await page.screenshot({
              path: join(screenshots, `fix-1842-step8-panels-drawer-${theme}-phone.png`),
              fullPage: true,
              animations: "disabled",
            });
            await page.getByRole("button", { name: "Hide panels sidebar" }).click();
          }
          expect(metrics.overflow).toBe(false);
        }
      } finally {
        await page.close();
      }
    }
    process.stdout.write(`${output.join("\n")}\n`);
  },
);

realTest("pins the edit-earlier control in a chat with messages", async ({ realApp }) => {
  const output: string[] = [];
  for (const theme of THEMES) {
    const page = await realApp.open({
      beforeLoad: async (loadedPage) => {
        await loadedPage.addInitScript(
          (value) => window.localStorage.setItem("omp-app.theme", value),
          theme,
        );
        await loadedPage.emulateMedia({ colorScheme: theme });
      },
    });
    try {
      const composer = await startChat(page);
      await sendPrompt(composer, "Please write a short answer for the edit control audit.");
      const userMessage = page.locator('[data-slot="u1-message-row"][data-role="user"]').first();
      await expect(userMessage).toBeVisible({ timeout: 60_000 });
      await page.setViewportSize({ width: 390, height: 844 });
      await waitForFiniteAnimations(page);
      const edit = page.getByRole("button", { name: "Edit an earlier message", exact: true });
      await expect(edit).toBeVisible();
      const metrics = await edit.evaluate((element) => {
        const button = element as HTMLElement;
        const textNode = Array.from(button.childNodes).find(
          (node): node is Text =>
            node.nodeType === Node.TEXT_NODE && node.textContent?.trim() !== "",
        );
        const textBox = textNode
          ? (() => {
              const range = document.createRange();
              range.selectNodeContents(textNode);
              return range.getBoundingClientRect();
            })()
          : null;
        const computed = getComputedStyle(button);
        const placeholder = document.querySelector<HTMLElement>(
          '[data-shell-region="composer"] textarea',
        );
        return {
          width: button.getBoundingClientRect().width,
          height: button.getBoundingClientRect().height,
          textWidth: textBox?.width ?? 0,
          paddingInline: computed.paddingInline,
          fontSize: computed.fontSize,
          borderTopWidth: computed.borderTopWidth,
          borderRightWidth: computed.borderRightWidth,
          borderBottomWidth: computed.borderBottomWidth,
          borderLeftWidth: computed.borderLeftWidth,
          background: computed.backgroundColor,
          color: computed.color,
          placeholderColor: placeholder
            ? getComputedStyle(placeholder, "::placeholder").color
            : null,
        };
      });
      output.push(
        `Edit control (${theme}, phone) | 28px high, 8px inline padding, 13px font, no border, transparent background, placeholder colour | ${metrics.width.toFixed(1)}px wide (${metrics.textWidth.toFixed(1)}px text), ${metrics.height.toFixed(1)}px high, ${metrics.paddingInline} padding, ${metrics.fontSize} font, borders ${metrics.borderTopWidth}/${metrics.borderRightWidth}/${metrics.borderBottomWidth}/${metrics.borderLeftWidth}, ${metrics.background} background, ${metrics.color} text / ${metrics.placeholderColor} placeholder`,
      );
      expect(metrics.height).toBe(28);
      expect(metrics.paddingInline).toBe("8px");
      expect(metrics.fontSize).toBe("13px");
      expect(metrics.borderTopWidth).toBe("0px");
      expect(metrics.borderRightWidth).toBe("0px");
      expect(metrics.borderBottomWidth).toBe("0px");
      expect(metrics.borderLeftWidth).toBe("0px");
      expect(metrics.background).toBe("rgba(0, 0, 0, 0)");
      expect(metrics.placeholderColor).not.toBeNull();
      expect(metrics.color).toBe(metrics.placeholderColor);
      expect(metrics.width).toBeLessThanOrEqual(metrics.textWidth + 16 + 1);
    } finally {
      await page.close();
    }
  }
  process.stdout.write(`${output.join("\n")}\n`);
});

realTest("pins the long user bubble and both 28px composer controls", async ({ realApp }) => {
  const page = await realApp.open();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChat(page);
    await sendPrompt(composer, "A deliberately long user message for the width pin. ".repeat(20));
    const userRow = page.locator('[data-slot="u1-message-row"][data-role="user"]').first();
    const bubble = userRow.locator('[data-message-surface="user-bubble"]');
    await expect(bubble).toBeVisible({ timeout: 60_000 });
    const width = await userRow.evaluate((row) => {
      const userBubble = row.querySelector<HTMLElement>('[data-message-surface="user-bubble"]');
      if (!userBubble) throw new Error("The user bubble is missing");
      const style = getComputedStyle(row);
      return {
        content:
          row.getBoundingClientRect().width -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight),
        bubble: userBubble.getBoundingClientRect().width,
      };
    });
    process.stdout.write(
      `User bubble cap (light, desktop) | max-width 80% | ${width.bubble.toFixed(1)}px / ${width.content.toFixed(1)}px (${((width.bubble / width.content) * 100).toFixed(1)}%) | ${(width.bubble - width.content * 0.8).toFixed(1)}px from 80%\n`,
    );
    expect(Math.abs(width.bubble - width.content * 0.8)).toBeLessThanOrEqual(1);
    const execution = page.getByRole("button", { name: "Execution modes", exact: true });
    const model = page.locator(
      '[data-composer-toolbar] button[aria-label^="Model:"], [data-composer-toolbar] button[aria-label="Choose a model"]',
    );
    expect((await execution.boundingBox())?.height).toBe(28);
    expect((await model.boundingBox())?.height).toBe(28);
  } finally {
    await page.close();
  }
});

realTest("pins the usage popup to no visible shadow", async ({ realApp }) => {
  const page = await realApp.open();
  try {
    await startChat(page);
    const usageButton = page.getByRole("button", { name: /Usage/ });
    await expect(usageButton).toBeVisible();
    await usageButton.click();
    const usage = page.locator('[role="dialog"][aria-label="Session usage details"]');
    await expect(usage).toBeVisible();
    expectNoVisibleShadow(await usage.evaluate((element) => getComputedStyle(element).boxShadow));
  } finally {
    await page.close();
  }
});
realTest("pins the Rules tab to fill the Panels region", async ({ realApp }) => {
  const page = await realApp.open();
  try {
    await startChat(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    const showPanels = page.getByRole("button", { name: /show panels sidebar/i });
    if ((await showPanels.count()) > 0) await showPanels.first().click();
    const rulesTab = page.getByRole("tab", { name: "Rules", exact: true });
    await expect(rulesTab).toBeVisible();
    await rulesTab.click();
    const rules = page.getByRole("region", { name: "Rules", exact: true });
    await expect(rules).toBeVisible();
    const rulesBox = await rules.boundingBox();
    const sidebar = page.locator('[data-shell-sidebar="right"]');
    const sidebarBox = await sidebar.boundingBox();
    if (!rulesBox || !sidebarBox) throw new Error("Rules panel surfaces are missing");
    const geometry = {
      bottomDifference: sidebarBox.y + sidebarBox.height - (rulesBox.y + rulesBox.height),
      topDifference: rulesBox.y - sidebarBox.y,
    };
    expect(Math.abs(geometry.bottomDifference)).toBeLessThanOrEqual(1);
    expect(geometry.topDifference).toBeGreaterThanOrEqual(0);
  } finally {
    await page.close();
  }
});
