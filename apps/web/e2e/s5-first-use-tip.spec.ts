import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const TIP = "Message, or type / for commands";
const DEFAULT_PLACEHOLDER = "Send a message...";
const SENDS_KEY = "omp-app.slash-sends";

realTest.use({ ompBinary: "/cache/bun/omp-18.12.2" });

async function assertPlaceholderColor(page: Page): Promise<void> {
  const input = page.getByRole("textbox", { name: "Message input" });
  const colors = await input.evaluate((element) => {
    const probe = document.createElement("span");
    probe.className = "text-muted-foreground";
    document.body.append(probe);
    const expected = getComputedStyle(probe).color;
    const actual = getComputedStyle(element, "::placeholder").color;
    probe.remove();
    return { actual, expected };
  });
  expect(colors.expected).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.actual).toBe(colors.expected);
}

async function assertSingleLineAtPhoneWidth(page: Page): Promise<void> {
  const input = page.getByRole("textbox", { name: "Message input" });
  const dimensions = await input.evaluate(async (element) => {
    const textarea = element as HTMLTextAreaElement;
    const tip = textarea.placeholder;
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    textarea.placeholder = "Send a message...";
    await nextFrame();
    const oldHeight = textarea.getBoundingClientRect().height;
    textarea.placeholder = tip;
    await nextFrame();
    const tipHeight = textarea.getBoundingClientRect().height;
    const style = getComputedStyle(textarea);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas text measurement is unavailable.");
    context.font = style.font;
    const textWidth = context.measureText(tip).width;
    const availableWidth =
      textarea.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);
    return { oldHeight, tipHeight, textWidth, availableWidth };
  });
  expect(dimensions.tipHeight).toBe(dimensions.oldHeight);
  expect(dimensions.textWidth).toBeLessThanOrEqual(dimensions.availableWidth);
}

realTest(
  "shows the first-use tip until three successful slash sends and remembers retirement",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const input = await startChat(page);
    await expect(input).toHaveAttribute("placeholder", TIP);
    await assertPlaceholderColor(page);
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "s5-first-use-tip-light.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await assertSingleLineAtPhoneWidth(page);
    await assertPlaceholderColor(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "s5-first-use-tip-phone-390.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });

    await input.fill("/clear");
    await input.press("Enter");
    await expect(page.getByRole("listbox")).toContainText("Only runs in omp's terminal", {
      timeout: 30_000,
    });
    await expect(input).toHaveValue("/clear");
    expect(await page.evaluate((key) => localStorage.getItem(key), SENDS_KEY)).toBeNull();
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "only runs in omp's terminal" }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(input).toHaveValue("/clear");
    expect(await page.evaluate((key) => localStorage.getItem(key), SENDS_KEY)).toBeNull();

    for (const count of [1, 2, 3]) {
      await input.fill("/context");
      await input.press("Enter");
      await expect(input).toHaveValue("", { timeout: 60_000 });
      await expect
        .poll(() => page.evaluate((key) => localStorage.getItem(key), SENDS_KEY), {
          timeout: 10_000,
        })
        .toBe(String(count));
      await expect(input).toHaveAttribute("placeholder", count < 3 ? TIP : DEFAULT_PLACEHOLDER);
    }

    await page.reload();
    const reloaded = page.getByRole("textbox", { name: "Message input" });
    await expect(reloaded).toBeVisible({ timeout: 60_000 });
    await expect(reloaded).toHaveAttribute("placeholder", DEFAULT_PLACEHOLDER);
    const nextChatInput = await startChat(page);
    await expect(nextChatInput).toHaveAttribute("placeholder", DEFAULT_PLACEHOLDER);

    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => {
          window.localStorage.setItem("omp-app.theme", "dark");
          window.localStorage.removeItem("omp-app.slash-sends");
        }),
    });
    await expect(dark.locator("html")).toHaveClass(/dark/);
    const darkInput = await startChat(dark);
    await expect(darkInput).toHaveAttribute("placeholder", TIP);
    await assertPlaceholderColor(dark);
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "s5-first-use-tip-dark.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
