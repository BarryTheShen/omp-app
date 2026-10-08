import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { RealApp } from "./real-omp";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const viewports = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 800 },
  { name: "1771", width: 1771, height: 1100 },
  { name: "1920", width: 1920, height: 1080 },
] as const;

async function expectComposerStyles(page: Page, dark: boolean) {
  const styles = await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>('[aria-label="Message input"]');
    const surface = input?.parentElement;
    if (!surface) {
      return {
        dark: document.documentElement.classList.contains("dark"),
        usesCardToken: false,
      };
    }
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--card)";
    document.body.append(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    const actual = getComputedStyle(surface).backgroundColor;
    probe.remove();
    return {
      dark: document.documentElement.classList.contains("dark"),
      usesCardToken: expected !== "rgba(0, 0, 0, 0)" && actual === expected,
    };
  });
  expect(styles.dark).toBe(dark);
  expect(styles.usesCardToken).toBe(true);
}

async function runComposerGrowth({ realApp }: { readonly realApp: RealApp }): Promise<void> {
  await mkdir(screenshots, { recursive: true });

  for (const theme of ["light", "dark"] as const) {
    const page = await realApp.open({
      beforeLoad: (openedPage) => openedPage.emulateMedia({ colorScheme: theme }),
    });
    const composer = await startChat(page);
    await composer.fill("First line");
    await composer.press("Shift+Enter");
    await composer.type("Second line");
    await expect(composer).toHaveValue("First line\nSecond line");

    // The textarea resizes after the input event, so each height is polled until it settles.
    const inputHeight = (): Promise<number> =>
      composer.evaluate((input) => input.getBoundingClientRect().height);

    for (const viewport of viewports) {
      await composer.fill("");
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      // The window narrows while the sidebars are still open; the empty box must measure again once
      // they fold, with nothing typed (#773).
      await expect
        .poll(inputHeight, { message: `${theme} ${viewport.name}px: empty input is one line` })
        .toBeLessThanOrEqual(32);
      const emptyMetrics = await composer.evaluate((input) => {
        const card = input.parentElement;
        if (!card) throw new Error("Composer card is missing");
        return {
          inputHeight: input.getBoundingClientRect().height,
          cardHeight: card.getBoundingClientRect().height,
        };
      });
      await composer.fill("First line");
      const oneLineHeight = await inputHeight();

      await composer.fill(["First line", "Second line", "Third line", "Fourth line"].join("\n"));
      await expect
        .poll(inputHeight, { message: `${theme} ${viewport.name}px: multiline height` })
        .toBeGreaterThan(oneLineHeight + 24);

      await composer.fill(Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join("\n"));
      await expect
        .poll(inputHeight, { message: `${theme} ${viewport.name}px: reaches its cap` })
        .toBeGreaterThanOrEqual(200);
      const cappedInput = await composer.evaluate((input) => {
        const card = input.parentElement;
        if (!card) throw new Error("Composer card is missing");
        return {
          height: input.getBoundingClientRect().height,
          clientHeight: input.clientHeight,
          scrollHeight: input.scrollHeight,
          overflowY: getComputedStyle(input).overflowY,
          cardHeight: card.getBoundingClientRect().height,
        };
      });
      expect(cappedInput.height, `${theme} ${viewport.name}px: eight-line cap`).toBeLessThanOrEqual(
        208,
      );
      expect(
        cappedInput.scrollHeight,
        `${theme} ${viewport.name}px: excess text scrolls`,
      ).toBeGreaterThan(cappedInput.clientHeight);
      expect(cappedInput.overflowY, `${theme} ${viewport.name}px: scrolling is enabled`).toBe(
        "auto",
      );
      expect(
        cappedInput.cardHeight,
        `${theme} ${viewport.name}px: card stays within the input growth cap`,
      ).toBeLessThanOrEqual(emptyMetrics.cardHeight + 208 - emptyMetrics.inputHeight + 2);
      await waitForFiniteAnimations(page);
      await page.screenshot({
        path: join(screenshots, `composer-growth-capped-${theme}-${viewport.name}.png`),
        fullPage: true,
      });

      await composer.fill(["First line", "Second line", "Third line", "Fourth line"].join("\n"));
      await expect(composer).toBeVisible();
      await expectComposerStyles(page, theme === "dark");
      await waitForFiniteAnimations(page);
      await page.screenshot({
        path: join(screenshots, `composer-growth-${theme}-${viewport.name}.png`),
        fullPage: true,
      });
    }
  }
}
realTest(
  "the composer grows with typed lines, then scrolls inside in both themes",
  runComposerGrowth,
);

realTest(
  "on a short window the composer's cap leaves room for the conversation",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    const composer = await startChat(page);
    await page.setViewportSize({ width: 640, height: 400 });
    await composer.fill(Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join("\n"));
    await expect
      .poll(() => composer.evaluate((input) => input.getBoundingClientRect().height), {
        message: "the input grows until it reaches its cap",
      })
      .toBeGreaterThanOrEqual(130);
    const metrics = await composer.evaluate((input) => ({
      height: input.getBoundingClientRect().height,
      scrolls: input.scrollHeight > input.clientHeight,
      windowHeight: window.innerHeight,
    }));
    expect(metrics.height, "the input is at most 35% of the window").toBeLessThanOrEqual(
      metrics.windowHeight * 0.35 + 1,
    );
    expect(metrics.scrolls, "the rest of the text scrolls inside the input").toBe(true);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "composer-growth-short-window.png"),
      fullPage: true,
    });
  },
);
