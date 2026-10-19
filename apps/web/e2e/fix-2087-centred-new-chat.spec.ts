import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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

realTest(
  "a new chat centers its greeting and composer, then restores the message layout",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    for (const theme of THEMES) {
      const page = await realApp.open({
        beforeLoad: async (loadedPage) => {
          await loadedPage.addInitScript((value) => {
            window.localStorage.setItem("omp-app.theme", value);
          }, theme);
          await loadedPage.emulateMedia({ colorScheme: theme });
        },
      });
      try {
        const composer = await startChat(page);
        const greeting = page.locator('[data-empty-chat="true"]');
        const editSelector = page.locator('[data-slot="p3-previous-message-selector"]');
        await expect(greeting).toBeVisible({ timeout: 60_000 });
        await expect(editSelector).toBeHidden();

        for (const viewport of VIEWPORTS) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await waitForFiniteAnimations(page);
          const emptyMetrics = await page.evaluate(() => {
            const header = document.querySelector<HTMLElement>('[data-shell-region="header"]');
            const greeting = document.querySelector<HTMLElement>('[data-empty-chat="true"]');
            const card = document.querySelector<HTMLElement>("[data-composer-card]");
            const main = document.querySelector<HTMLElement>('[data-shell-main="true"]');
            if (!header || !greeting || !card || !main) {
              throw new Error("The empty chat surfaces are missing");
            }
            const headerBox = header.getBoundingClientRect();
            const greetingBox = greeting.getBoundingClientRect();
            const cardBox = card.getBoundingClientRect();
            const mainBox = main.getBoundingClientRect();
            return {
              gap: cardBox.top - greetingBox.bottom,
              spaceAbove: greetingBox.top - headerBox.bottom,
              spaceBelow: mainBox.bottom - cardBox.bottom,
              overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
              font: getComputedStyle(greeting).fontFamily,
            };
          });
          expect(emptyMetrics.gap).toBeGreaterThanOrEqual(31);
          expect(emptyMetrics.gap).toBeLessThanOrEqual(33);
          expect(Math.abs(emptyMetrics.spaceAbove - emptyMetrics.spaceBelow)).toBeLessThanOrEqual(
            2,
          );
          expect(emptyMetrics.overflow).toBe(false);
          expect(emptyMetrics.font).toContain("Public Sans");
          await page.screenshot({
            path: join(screenshots, `fix-2087-empty-${theme}-${viewport.name}.png`),
          });
        }

        await sendPrompt(composer, "Please write a short answer for the layout check.");
        await expect(page.locator('[data-slot="u1-message-row"][data-role="user"]')).toBeVisible({
          timeout: 60_000,
        });
        await expect(greeting).toHaveCount(0);
        await expect(editSelector).toBeVisible();
        for (const viewport of VIEWPORTS) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await waitForFiniteAnimations(page);
          const chatLayout = await page.evaluate(() => {
            const main = document.querySelector<HTMLElement>('[data-shell-main="true"]');
            const transcript = document.querySelector<HTMLElement>(
              '[data-shell-region="transcript"]',
            );
            const thread = document.querySelector<HTMLElement>('[data-slot="u1-thread-viewport"]');
            const composerRegion = document.querySelector<HTMLElement>(
              '[data-shell-region="composer"]',
            );
            if (!main || !transcript || !thread || !composerRegion) {
              throw new Error("The chat layout surfaces are missing");
            }
            const mainBox = main.getBoundingClientRect();
            const transcriptBox = transcript.getBoundingClientRect();
            const threadBox = thread.getBoundingClientRect();
            const composerBox = composerRegion.getBoundingClientRect();
            return {
              composerBottomOffset: mainBox.bottom - composerBox.bottom,
              transcriptToComposerGap: composerBox.top - transcriptBox.bottom,
              threadToTranscriptGap: transcriptBox.bottom - threadBox.bottom,
              threadHeight: threadBox.height,
            };
          });
          expect(Math.abs(chatLayout.composerBottomOffset)).toBeLessThanOrEqual(1);
          expect(Math.abs(chatLayout.transcriptToComposerGap)).toBeLessThanOrEqual(1);
          expect(Math.abs(chatLayout.threadToTranscriptGap)).toBeLessThanOrEqual(1);
          expect(chatLayout.threadHeight).toBeGreaterThan(0);
          await page.screenshot({
            path: join(screenshots, `fix-2087-chat-${theme}-${viewport.name}.png`),
          });
        }
      } finally {
        await page.close();
      }
    }
  },
);
