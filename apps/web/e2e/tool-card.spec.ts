/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/U3/tool-card/card-playground.tsx",
      "--outdir",
      "dist/u3-card-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the tool-card playground.");
  writeFileSync(
    join(DIST_ROOT, "u3-card-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/u3-card-playground/card-playground.js"></script>
  </head>
  <body>
    <div id="u3-card-playground-root"></div>
  </body>
</html>
`,
  );
}

async function resolvedClassColor(page: Page, className: string) {
  return page.evaluate((value) => {
    const probe = document.createElement("span");
    probe.className = value;
    probe.style.position = "fixed";
    probe.style.visibility = "hidden";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, className);
}

async function resolvedBorderColor(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    probe.className = "border border-foreground/10";
    probe.style.position = "fixed";
    probe.style.visibility = "hidden";
    document.body.append(probe);
    const color = getComputedStyle(probe).borderLeftColor;
    probe.remove();
    return color;
  });
}

async function contrastOf(
  page: Page,
  textSelector: string,
  backgroundSelector: string,
  colorOverride?: string,
) {
  return page.evaluate(
    ({ textSelector: text, backgroundSelector: background, colorOverride: override }) => {
      const textElement = document.querySelector<HTMLElement>(text);
      const backgroundElement = document.querySelector<HTMLElement>(background);
      if (!textElement || !backgroundElement) throw new Error("contrast probe element is missing");
      let foreground = getComputedStyle(textElement).color;
      if (override !== undefined) {
        const probe = document.createElement("span");
        probe.style.color = override;
        document.body.append(probe);
        foreground = getComputedStyle(probe).color;
        probe.remove();
      }
      const context = document.createElement("canvas").getContext("2d");
      if (context === null) throw new Error("Canvas is unavailable");
      const backgroundColor = getComputedStyle(backgroundElement).backgroundColor;
      context.fillStyle = backgroundColor;
      context.fillRect(0, 0, 1, 1);
      const backgroundPixel = context.getImageData(0, 0, 1, 1).data;
      context.fillStyle = foreground;
      context.fillRect(0, 0, 1, 1);
      const foregroundPixel = context.getImageData(0, 0, 1, 1).data;
      const luminance = (pixel: Uint8ClampedArray) => {
        const channels = Array.from(pixel.slice(0, 3)).map((value) => {
          const normalized = value / 255;
          return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return (
          (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722
        );
      };
      const foregroundLuminance = luminance(foregroundPixel);
      const backgroundLuminance = luminance(backgroundPixel);
      return (
        (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
      );
    },
    { textSelector, backgroundSelector, colorOverride },
  );
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

test("renders every ToolCard state and captures light/dark/narrow screenshots", async ({
  page,
}) => {
  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => {
    document.addEventListener(
      "DOMContentLoaded",
      () => document.documentElement.classList.add("dark"),
      { once: true },
    );
  });
  await page.goto("/u3-card-playground.html");
  await expect(page.getByTestId("u3-card-playground")).toBeVisible();
  for (const phase of ["running", "partial", "success", "error", "cancelled"]) {
    await expect(page.getByTestId(`tool-state-chip-${phase}`)).toBeVisible();
  }
  await page.screenshot({ path: "../../.data/screenshots/u3.2-card-light.png", fullPage: true });

  await darkPage.goto("/u3-card-playground.html");
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await darkPage.screenshot({ path: "../../.data/screenshots/u3.2-card-dark.png", fullPage: true });
  await darkPage.setViewportSize({ width: 390, height: 844 });
  await darkPage.screenshot({
    path: "../../.data/screenshots/u3.2-card-narrow.png",
    fullPage: true,
  });
  await darkPage.close();
});

test("measures the complete trace grammar in both themes and at phone width", async ({ page }) => {
  const assertGrammar = async (target: Page, dark: boolean) => {
    await target.goto("/u3-card-playground.html");
    if (dark) await expect(target.locator("html")).toHaveClass(/dark/);
    else await expect(target.locator("html")).not.toHaveClass(/dark/);
    const expected = {
      running: { marker: "text-info", status: "text-info" },
      partial: { marker: "text-info", status: "text-info" },
      success: { marker: "text-muted-foreground/50", status: "text-muted-foreground" },
      error: { marker: "text-destructive", status: "text-destructive" },
      cancelled: { marker: "text-muted-foreground/50", status: "text-muted-foreground" },
      unrecorded: { marker: "text-muted-foreground/50", status: "text-muted-foreground" },
    } as const;
    const railColor = await resolvedBorderColor(target);
    const foreground = await resolvedClassColor(target, "text-foreground");
    const muted = await resolvedClassColor(target, "text-muted-foreground");
    const destructive = await resolvedClassColor(target, "text-destructive");
    const statuses = ["running", "partial", "success", "error", "cancelled", "unrecorded"] as const;
    for (const phase of statuses) {
      const card = target.getByTestId(`tool-card-playground-${phase}`);
      const trigger = card.getByRole("button");
      const marker = trigger.locator('[data-slot="u3-tool-card-icon"]');
      const label = trigger.locator(":scope > span").nth(1);
      const status = trigger.locator('[data-slot="u3-tool-card-status"]');
      await expect(marker).toHaveCSS(
        "color",
        await resolvedClassColor(target, expected[phase].marker),
      );
      await expect(status).toHaveCSS(
        "color",
        expected[phase].status === "text-destructive"
          ? destructive
          : expected[phase].status === "text-info"
            ? await resolvedClassColor(target, "text-info")
            : muted,
      );
      await expect(status).toHaveCSS("font-size", "11px");
      await expect(trigger).toHaveCSS("font-size", "12px");
      await expect(status).toHaveCSS("background-color", /rgba?\(0, 0, 0(?:, 0)?\)/);
      await expect(status).toHaveCSS("border-left-width", "0px");
      const geometry = await trigger.evaluate((element) => {
        const row = element.getBoundingClientRect();
        const state = element.querySelector<HTMLElement>("[data-slot='u3-tool-card-status']");
        if (!state) throw new Error("status word is missing");
        return { rowRight: row.right, statusRight: state.getBoundingClientRect().right };
      });
      expect(Math.abs(geometry.rowRight - geometry.statusRight)).toBeLessThanOrEqual(1);
      await expect(label).toHaveCSS("color", phase === "error" ? destructive : muted);
      await label.hover();
      await expect(label).toHaveCSS("color", phase === "error" ? destructive : foreground);
      await expect(marker).toHaveCSS("rotate", "none");
      await expect(marker).toHaveCSS("transform", "none");
      await trigger.click();
      await expect(marker).toHaveCSS("rotate", "90deg");
      await expect(marker).toHaveCSS("transform", "none");
      const rail = card.locator('[data-slot="u3-tool-card-content"] > div > div').first();
      await expect(rail).toHaveCSS("border-left-width", "1px");
      await expect(rail).toHaveCSS("border-left-color", railColor);
      await expect(rail).toHaveCSS("padding-left", "16px");
      await expect(rail).toHaveCSS("margin-left", "5px");
      if (phase === "running") await expect(label).toHaveCSS("animation-name", "pulse");
    }
    const errorStatus = target.getByTestId("tool-state-chip-error");
    expect(
      await contrastOf(target, '[data-testid="tool-state-chip-error"]', "main"),
    ).toBeGreaterThanOrEqual(4.5);
    await errorStatus.evaluate((element) => {
      (element as HTMLElement).style.color = "var(--background)";
    });
    expect(await contrastOf(target, '[data-testid="tool-state-chip-error"]', "main")).toBeLessThan(
      4.5,
    );
    await errorStatus.evaluate((element) => {
      (element as HTMLElement).style.color =
        "color-mix(in srgb, var(--muted-foreground) 30%, transparent)";
    });
    expect(await contrastOf(target, '[data-testid="tool-state-chip-error"]', "main")).toBeLessThan(
      4.5,
    );
    await target.emulateMedia({ reducedMotion: "reduce" });
    await target.reload();
    if (dark) await expect(target.locator("html")).toHaveClass(/dark/);
    else await expect(target.locator("html")).not.toHaveClass(/dark/);
    await expect(
      target
        .getByTestId("tool-card-playground-running")
        .getByRole("button")
        .locator(":scope > span")
        .nth(1),
    ).toHaveCSS("animation-duration", /^(?:0\.01ms|1e-05s)$/);
    await target.setViewportSize({ width: 390, height: 844 });
    expect(await target.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    const narrowError = target.getByTestId("tool-card-playground-error");
    await expect(narrowError.getByTestId("tool-state-chip-error")).toBeVisible();
    await expect(narrowError.getByRole("button").locator(":scope > span").nth(2)).toHaveCSS(
      "text-overflow",
      "ellipsis",
    );
  };
  await assertGrammar(page, false);
  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => {
    document.addEventListener(
      "DOMContentLoaded",
      () => document.documentElement.classList.add("dark"),
      { once: true },
    );
  });
  await assertGrammar(darkPage, true);
  await darkPage.close();
});
