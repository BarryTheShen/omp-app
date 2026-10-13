import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/*
 * Issue 1304: a link in a reply looked like the sentence around it (the same colour, no underline). The fake model
 * answers `link_probe` with one paragraph holding a named link, a disguised link and a bare URL.
 */

const transcript = (page: Page): Locator =>
  page.getByRole("region", { name: "Conversation transcript" });

realTest(
  "a link in a reply looks like a link, with a hover and a focus ring (issue 1304)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "link_probe");

    const links = transcript(page).getByRole("link");
    await expect(links).toHaveCount(3, { timeout: 120_000 });
    const first = links.nth(0);
    for (let index = 0; index < 3; index += 1) {
      const link = links.nth(index);
      await expect
        .poll(() => link.evaluate((element) => getComputedStyle(element).textDecorationLine))
        .toBe("underline");
    }

    // Its colour differs from the sentence around it, which is its parent element's colour.
    const linkColor = await first.evaluate((element) => getComputedStyle(element).color);
    const sentenceColor = await first.evaluate(
      (element) => getComputedStyle(element.parentElement ?? element).color,
    );
    expect(linkColor).not.toBe(sentenceColor);

    // Hovering it changes its colour.
    await page.mouse.move(0, 0);
    const restColor = await first.evaluate((element) => getComputedStyle(element).color);
    await first.hover();
    await expect
      .poll(() => first.evaluate((element) => getComputedStyle(element).color))
      .not.toBe(restColor);

    // Focusing it by keyboard draws the shared focus ring around it.
    await first.focus();
    await expect
      .poll(() => first.evaluate((element) => element.matches(":focus-visible")))
      .toBe(true);
    await expect
      .poll(() => first.evaluate((element) => getComputedStyle(element).outlineStyle))
      .toBe("solid");
    await page.screenshot({ path: join(screenshots, "fix-1304-link-style-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await expect
      .poll(() => first.evaluate((element) => getComputedStyle(element).textDecorationLine))
      .toBe("underline");
    await page.screenshot({ path: join(screenshots, "fix-1304-link-style-dark.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-shell-sidebar="left"]')).toHaveAttribute("data-open", "false");
    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute(
      "data-open",
      "false",
    );
    await waitForFiniteAnimations(page);
    await expect(first).toBeVisible();
    await expect
      .poll(() => first.evaluate((element) => getComputedStyle(element).textDecorationLine))
      .toBe("underline");
    await page.screenshot({ path: join(screenshots, "fix-1304-link-style-narrow.png") });
  },
);
