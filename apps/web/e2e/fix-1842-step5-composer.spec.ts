import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  type RealApp,
  realTest,
  screenshots,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;
const themes = ["light", "dark"] as const;
type Theme = (typeof themes)[number];

interface ComposerMetrics {
  readonly card: {
    readonly width: number;
    readonly height: number;
    readonly borderWidth: string;
    readonly borderRadius: string;
    readonly borderColor: string;
    readonly backgroundColor: string;
    readonly expectedBorderColor: string;
    readonly expectedBackgroundColor: string;
    readonly expectedFocusBorderColor: string;
    readonly focusBorderColor: string;
    readonly unfocusedBorderColor: string;
    readonly focusShadow: string;
    readonly unfocusedShadow: string;
  };
  readonly input: {
    readonly fontSize: string;
    readonly lineHeight: string;
    readonly paddingTop: string;
    readonly paddingInline: string;
    readonly paddingBottom: string;
    readonly placeholderColor: string;
    readonly expectedPlaceholderColor: string;
  };
  readonly buttons: {
    readonly attachment: {
      readonly width: number;
      readonly height: number;
      readonly radius: string;
    };
    readonly send: {
      readonly width: number;
      readonly height: number;
      readonly radius: string;
      readonly backgroundColor: string;
      readonly expectedBackgroundColor: string;
      readonly iconColor: string;
      readonly expectedIconColor: string;
    };
    readonly stop: {
      readonly width: number;
      readonly height: number;
      readonly radius: string;
    } | null;
    readonly activeModeBackground: string;
    readonly expectedActiveModeBackground: string;
  };
  readonly statusFontSize: string;
  readonly contextFontSize: string;
  readonly modelTextClipped: boolean;
  readonly attachmentStripAboveInput: boolean;
  readonly toolbarControlsInsideCard: boolean;
  readonly toolbarLabels: string[];
  readonly horizontalOverflow: boolean;
  readonly editButton: {
    readonly height: number;
    readonly paddingInline: string;
    readonly fontSize: string;
    readonly borderWidth: string;
    readonly backgroundColor: string;
    readonly color: string;
    readonly width: number;
    readonly textWidth: number;
  };
}

async function openTheme(realApp: Pick<RealApp, "open">, theme: Theme): Promise<Page> {
  return realApp.open({
    beforeLoad: async (page) => {
      await page.addInitScript((initialTheme: Theme) => {
        window.localStorage.setItem("omp-app.theme", initialTheme);
        document.documentElement?.classList.toggle("dark", initialTheme === "dark");
      }, theme);
    },
  });
}

async function measureComposer(page: Page): Promise<ComposerMetrics> {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>('[aria-label="Message input"]');
    const card = input?.closest<HTMLElement>("[data-composer-card]");
    const attachment = card?.querySelector<HTMLButtonElement>('[aria-label="Add attachment"]');
    const attachmentStrip = card?.querySelector<HTMLElement>(
      '[data-slot="u2-composer-attachments"]',
    );
    const activeMode = card?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    const status = document.querySelector<HTMLElement>("[data-n1-status]");
    const context = document.querySelector<HTMLElement>('[aria-label="Context status"]');
    const send = card?.querySelector<HTMLButtonElement>('[aria-label="Send message"]');
    const editButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Edit an earlier message",
    );
    const modelControl = card?.querySelector<HTMLButtonElement>(
      'button[aria-label^="Model:"], button[aria-label="Choose a model"]',
    );
    if (
      !input ||
      !card ||
      !attachment ||
      !send ||
      !activeMode ||
      !status ||
      !context ||
      !modelControl ||
      !editButton
    ) {
      throw new Error("The composer acceptance surfaces are missing");
    }
    const cardRect = card.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    const attachmentStripRect = attachmentStrip?.getBoundingClientRect();
    const toolbarControls = Array.from(
      card.querySelectorAll<HTMLButtonElement>("[data-composer-toolbar] button"),
    );
    const resolve = (property: string, cssProperty: string): string => {
      const probe = document.createElement("span");
      probe.style.setProperty(cssProperty, `var(${property})`);
      document.body.append(probe);
      const value = getComputedStyle(probe).getPropertyValue(cssProperty).trim();
      probe.remove();
      return value;
    };
    const resolveColorMix = (color: string, amount: string): string => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = `color-mix(in oklab, var(${color}) ${amount}, transparent)`;
      document.body.append(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    };
    card.style.transition = "none";
    const focusSink = document.createElement("button");
    focusSink.tabIndex = -1;
    document.body.append(focusSink);
    focusSink.focus();
    const style = getComputedStyle(card);
    const inputStyle = getComputedStyle(input);
    const attachmentStyle = getComputedStyle(attachment);
    const sendStyle = getComputedStyle(send);
    const activeStyle = getComputedStyle(activeMode);
    const sendIcon = send.querySelector<SVGElement>("svg");
    const beforeFocus = { border: style.borderTopColor, shadow: style.boxShadow };
    const initialBorderWidth = style.borderTopWidth;
    const initialBorderRadius = style.borderTopLeftRadius;
    const initialBorderColor = style.borderTopColor;
    const initialBackgroundColor = style.backgroundColor;
    input.focus();
    const afterFocus = getComputedStyle(card);
    focusSink.remove();
    const stop = card.querySelector<HTMLButtonElement>('[aria-label="Stop generating"]');
    const stopStyle = stop === null ? null : getComputedStyle(stop);
    const toolbarLabels = Array.from(
      card.querySelectorAll("button"),
      (button) => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
    );
    const editTextRange = document.createRange();
    editTextRange.selectNodeContents(editButton);
    const editStyle = getComputedStyle(editButton);
    return {
      card: {
        width: card.getBoundingClientRect().width,
        height: card.getBoundingClientRect().height,
        borderWidth: initialBorderWidth,
        borderRadius: initialBorderRadius,
        borderColor: initialBorderColor,
        backgroundColor: initialBackgroundColor,
        expectedBorderColor: resolveColorMix("--foreground", "10%"),
        expectedBackgroundColor: resolveColorMix("--muted", "30%"),
        expectedFocusBorderColor: resolveColorMix("--foreground", "25%"),
        focusBorderColor: afterFocus.borderTopColor,
        unfocusedBorderColor: beforeFocus.border,
        focusShadow: afterFocus.boxShadow,
        unfocusedShadow: beforeFocus.shadow,
      },
      attachmentStripAboveInput:
        attachmentStrip !== null &&
        attachmentStripRect !== undefined &&
        attachmentStripRect.bottom <= inputRect.top + 1,
      toolbarControlsInsideCard: toolbarControls.every((button) => {
        const rect = button.getBoundingClientRect();
        return (
          rect.left >= cardRect.left &&
          rect.top >= cardRect.top &&
          rect.right <= cardRect.right &&
          rect.bottom <= cardRect.bottom
        );
      }),
      input: {
        fontSize: inputStyle.fontSize,
        lineHeight: inputStyle.lineHeight,
        paddingTop: inputStyle.paddingTop,
        paddingInline: inputStyle.paddingInlineStart,
        paddingBottom: inputStyle.paddingBottom,
        placeholderColor: getComputedStyle(input, "::placeholder").color,
        expectedPlaceholderColor: resolve("--muted-foreground", "color"),
      },
      buttons: {
        attachment: {
          width: attachment.getBoundingClientRect().width,
          height: attachment.getBoundingClientRect().height,
          radius: attachmentStyle.borderTopLeftRadius,
        },
        send: {
          width: send.getBoundingClientRect().width,
          height: send.getBoundingClientRect().height,
          radius: sendStyle.borderTopLeftRadius,
          backgroundColor: sendStyle.backgroundColor,
          expectedBackgroundColor: resolve("--primary", "background-color"),
          iconColor: sendIcon ? getComputedStyle(sendIcon).color : "",
          expectedIconColor: resolve("--primary-foreground", "color"),
        },
        stop:
          stop === null || stopStyle === null
            ? null
            : {
                width: stop.getBoundingClientRect().width,
                height: stop.getBoundingClientRect().height,
                radius: stopStyle.borderTopLeftRadius,
              },
        activeModeBackground: activeStyle.backgroundColor,
        expectedActiveModeBackground: resolveColorMix("--foreground", "6%"),
      },
      editButton: {
        height: editButton.getBoundingClientRect().height,
        paddingInline: editStyle.paddingInline,
        fontSize: editStyle.fontSize,
        borderWidth: editStyle.borderTopWidth,
        backgroundColor: editStyle.backgroundColor,
        color: editStyle.color,
        width: editButton.getBoundingClientRect().width,
        textWidth: editTextRange.getBoundingClientRect().width,
      },
      statusFontSize: getComputedStyle(status).fontSize,
      contextFontSize: getComputedStyle(context).fontSize,
      modelTextClipped: Array.from(modelControl.querySelectorAll(":scope > span")).some(
        (span) => span.scrollWidth > span.clientWidth,
      ),
      toolbarLabels,
      horizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

async function assertMetrics(
  page: Page,
  metrics: ComposerMetrics,
  viewport: (typeof viewports)[number],
  theme: Theme,
): Promise<void> {
  const darkMode = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  expect(darkMode, `${theme} theme before capture`).toBe(theme === "dark");
  if (viewport.width === 1280) {
    expect(metrics.card.width, `${viewport.name}: card width`).toBe(672);
    expect(metrics.card.height, `${viewport.name}: empty card height`).toBe(82);
  } else {
    expect(metrics.card.width, `${viewport.name}: card width`).toBe(342);
    expect(metrics.card.height, `${viewport.name}: wrapped toolbar height`).toBe(116);
  }
  expect(metrics.attachmentStripAboveInput, `${viewport.name}: attachment strip above input`).toBe(
    true,
  );
  expect(metrics.toolbarControlsInsideCard, `${viewport.name}: toolbar controls inside card`).toBe(
    true,
  );
  expect(metrics.card.borderWidth, `${viewport.name}: card border`).toBe("1px");
  expect(metrics.card.borderRadius, `${viewport.name}: card radius`).toBe("16px");
  expect(metrics.card.borderColor, `${viewport.name}: card border color`).toBe(
    metrics.card.expectedBorderColor,
  );
  expect(metrics.card.backgroundColor, `${viewport.name}: card surface`).toBe(
    metrics.card.expectedBackgroundColor,
  );
  expect(metrics.input).toMatchObject({
    fontSize: "16px",
    lineHeight: "24px",
    paddingTop: "12px",
    paddingInline: "16px",
    paddingBottom: "8px",
    placeholderColor: metrics.input.expectedPlaceholderColor,
  });
  expect(metrics.editButton).toMatchObject({
    height: 28,
    paddingInline: "8px",
    fontSize: "13px",
    borderWidth: "0px",
    backgroundColor: "rgba(0, 0, 0, 0)",
  });
  expect(metrics.editButton.color).toBe(metrics.input.expectedPlaceholderColor);
  expect(metrics.editButton.width).toBeLessThanOrEqual(metrics.editButton.textWidth + 16);
  expect(metrics.buttons.attachment).toEqual({ width: 28, height: 28, radius: "8px" });
  expect(metrics.buttons.send).toMatchObject({
    width: 28,
    height: 28,
    radius: "8px",
    backgroundColor: metrics.buttons.send.expectedBackgroundColor,
    iconColor: metrics.buttons.send.expectedIconColor,
  });
  expect(metrics.buttons.activeModeBackground).toBe(metrics.buttons.expectedActiveModeBackground);
  expect(metrics.statusFontSize).toBe("11px");
  expect(metrics.contextFontSize).toBe("11px");
  expect(metrics.modelTextClipped, `${viewport.name}: model control text`).toBe(false);
  expect(metrics.horizontalOverflow, `${viewport.name}: horizontal overflow`).toBe(false);
  expect(metrics.card.focusBorderColor, `${viewport.name}: focus border color`).toBe(
    metrics.card.expectedFocusBorderColor,
  );
  expect(metrics.card.focusShadow, `${viewport.name}: retained focus ring`).not.toBe("none");
  const labels = metrics.toolbarLabels;
  const prompt = labels.indexOf("Prompt");
  const bash = labels.indexOf("Bash");
  const python = labels.indexOf("Python");
  const execution = labels.indexOf("Execution modes");
  expect(labels[0]).toBe("Add attachment");
  expect(labels[1]).toMatch(/^(?:Model:|Choose a model)/);
  expect(labels[2]).toBe("Prompt");
  expect(prompt).toBeLessThan(bash);
  expect(bash).toBeLessThan(python);
  expect(python).toBeLessThan(execution);
  await expect(
    page
      .locator('[data-shell-region="header"]')
      .getByRole("button", { name: /^(?:Model:|Choose a model)/ }),
  ).toHaveCount(0);
}

realTest(
  "composer card measured values match the Step 5 specification in both themes and viewports",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    for (const theme of themes) {
      const page = await openTheme(realApp, theme);
      const composer = await startChat(page);
      await expect(
        page.getByRole("main", { name: "Conversation" }).locator('[data-slot="u1-thread-empty"]'),
      ).toBeVisible({ timeout: 60_000 });
      for (const viewport of viewports) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await expect(composer).toBeVisible();
        await waitForFiniteAnimations(page);
        const metrics = await measureComposer(page);
        await assertMetrics(page, metrics, viewport, theme);
        await page.screenshot({
          path: join(screenshots, `fix-1842-step5-integrated-${theme}-${viewport.width}.png`),
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await composer.fill("slow_tool");
      await page.getByRole("button", { name: "Send message" }).click();
      const stop = page.getByRole("button", { name: "Stop generating" });
      await expect(stop).toBeVisible({ timeout: 60_000 });
      const stopMetrics = await stop.evaluate((button) => {
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height, radius: style.borderTopLeftRadius };
      });
      expect(stopMetrics, "phone: stop button").toEqual({ width: 28, height: 28, radius: "8px" });
      await stop.click();
      await expect(stop).toBeHidden({ timeout: 30_000 });
      await page.close();
    }
  },
);

realTest(
  "busy composer surfaces keep the queue, paste choice, attachment chip and blocked reason styled",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await openTheme(realApp, "light");
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChat(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add attachment" }).click();
    await (await chooser).setFiles({
      name: "busy.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("busy composer attachment"),
    });
    await expect(page.locator('[data-slot="u2-composer-attachments"]')).toContainText("busy.txt");
    await composer.evaluate((input) => {
      const data = new DataTransfer();
      data.setData(
        "text/plain",
        Array.from({ length: 120 }, (_, index) => `line ${index}`).join("\n"),
      );
      input.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
      );
    });
    const pasteChoice = page.locator('[data-composer-paste-choice="true"]');
    await expect(pasteChoice).toBeVisible();
    const busyMetrics = await page.evaluate(() => {
      const queue = document.querySelector<HTMLElement>("[data-queue-bar]");
      const paste = document.querySelector<HTMLElement>('[data-composer-paste-choice="true"]');
      const blocked = document.querySelector<HTMLElement>("[data-composer-blocked]");
      const chip = document.querySelector<HTMLElement>('[data-slot="attachment-root"]');
      const chipName = Array.from(chip?.querySelectorAll<HTMLElement>("span") ?? []).find(
        (span) => span.textContent?.trim() === "busy.txt",
      );
      const chipStrip = chip?.parentElement;
      const card = chip?.closest<HTMLElement>("[data-composer-card]");
      const input = card?.querySelector<HTMLTextAreaElement>('[aria-label="Message input"]');
      if (!paste || !blocked || !chip || !chipName || !chipStrip || !card || !input) {
        throw new Error("Busy composer surfaces are missing");
      }
      const chipStripRect = chipStrip.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      const probe = document.createElement("span");
      probe.style.backgroundColor = "color-mix(in oklab, var(--muted) 30%, transparent)";
      document.body.append(probe);
      const mutedSurface = getComputedStyle(probe).backgroundColor;
      probe.style.backgroundColor = "color-mix(in oklab, var(--foreground) 10%, transparent)";
      const borderSurface = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        chipAboveInput: chipStripRect.bottom <= inputRect.top + 1,
        queue: queue
          ? {
              background: getComputedStyle(queue).backgroundColor,
              radius: getComputedStyle(queue).borderTopLeftRadius,
              fontSize: getComputedStyle(queue).fontSize,
            }
          : null,
        paste: {
          background: getComputedStyle(paste).backgroundColor,
          radius: getComputedStyle(paste).borderTopLeftRadius,
          fontSize: getComputedStyle(paste).fontSize,
        },
        blocked: { fontSize: getComputedStyle(blocked).fontSize },
        chip: {
          background: getComputedStyle(chip).backgroundColor,
          radius: getComputedStyle(chip).borderTopLeftRadius,
          borderWidth: getComputedStyle(chip).borderTopWidth,
          borderColor: getComputedStyle(chip).borderTopColor,
          shadow: getComputedStyle(chip).boxShadow,
          nameFontSize: getComputedStyle(chipName).fontSize,
          stripPaddingInlineStart: getComputedStyle(chipStrip).paddingInlineStart,
          stripPaddingBottom: getComputedStyle(chipStrip).paddingBottom,
        },
        mutedSurface,
        borderSurface,
      };
    });
    expect(busyMetrics.paste).toMatchObject({
      background: busyMetrics.mutedSurface,
      radius: "10px",
      fontSize: "13px",
    });
    expect(busyMetrics.blocked.fontSize).toBe("13px");
    expect(busyMetrics.chipAboveInput).toBe(true);
    expect(busyMetrics.chip).toEqual({
      background: busyMetrics.mutedSurface,
      radius: "10px",
      borderWidth: "1px",
      borderColor: busyMetrics.borderSurface,
      shadow: "none",
      nameFontSize: "13px",
      stripPaddingInlineStart: "8px",
      stripPaddingBottom: "8px",
    });
    await page.screenshot({
      path: join(screenshots, "fix-1842-step5-busy-light.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Paste inline" }).click();
    await page.getByRole("button", { name: "Remove busy.txt" }).click();
    await expect(page.getByRole("button", { name: "Remove busy.txt" })).toHaveCount(0);

    await composer.fill("slow_tool");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 60_000,
    });
    const steerHint = page.locator('[data-composer-steer-hint="true"]');
    await expect(steerHint).toBeVisible();
    const hintEdges = await Promise.all([
      steerHint.boundingBox(),
      page.getByRole("button", { name: "Stop generating" }).boundingBox(),
    ]);
    if (!hintEdges[0] || !hintEdges[1]) throw new Error("Running steer/stop surfaces are missing");
    expect(hintEdges[0].x + hintEdges[0].width).toBeLessThanOrEqual(hintEdges[1].x);
    const steerStyle = await steerHint.evaluate((element) => {
      const style = getComputedStyle(element);
      return { overflow: style.overflow, textOverflow: style.textOverflow };
    });
    expect(steerStyle).toEqual({ overflow: "hidden", textOverflow: "ellipsis" });
    await composer.fill("queued while running");
    await composer.press("Control+Enter");
    const queue = page.locator("[data-queue-bar]");
    await expect(queue).toBeVisible({ timeout: 30_000 });
    const queueMetrics = await queue.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        radius: style.borderTopLeftRadius,
        fontSize: style.fontSize,
      };
    });
    expect(queueMetrics).toEqual({
      background: busyMetrics.mutedSurface,
      radius: "10px",
      fontSize: "13px",
    });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1842-step5-queue-light.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Stop generating" }).click();
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden({
      timeout: 30_000,
    });
    await page.close();
  },
);
