import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import {
  openAllToolCards,
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
interface ThemedPage {
  readonly page: Page;
  readonly fontRequests: string[];
}

async function openThemePage(realApp: Pick<RealApp, "open">, theme: Theme): Promise<ThemedPage> {
  const fontRequests: string[] = [];
  const page = await realApp.open({
    beforeLoad: async (target) => {
      target.on("request", (request) => {
        if (request.resourceType() === "font") fontRequests.push(request.url());
      });
      await target.addInitScript((initialTheme: Theme) => {
        try {
          localStorage.setItem("omp-app.theme", initialTheme);
        } catch {
          // The initial about:blank document may not expose storage; the app origin will.
        }
      }, theme);
    },
  });
  return { page, fontRequests };
}

async function assertFoundation({ page, fontRequests }: ThemedPage, theme: Theme): Promise<void> {
  const metrics = await page.evaluate(async () => {
    const publicFonts = await document.fonts.load('16px "Public Sans"');
    const monoFonts = await document.fonts.load('12px "JetBrains Mono"');
    const resolveToken = (property: string, cssProperty = "background-color") => {
      const probe = document.createElement("div");
      probe.style.setProperty(cssProperty, `var(${property})`);
      document.body.append(probe);
      const value = getComputedStyle(probe).getPropertyValue(cssProperty).trim();
      probe.remove();
      return value;
    };
    const measureType = (className: string) => {
      const probe = document.createElement("span");
      probe.className = className;
      probe.textContent = "Demo";
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const value = {
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontFamily: style.fontFamily,
      };
      probe.remove();
      return value;
    };
    const measureRadius = (className: string) => {
      const probe = document.createElement("div");
      probe.className = className;
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      document.body.append(probe);
      const value = getComputedStyle(probe).borderRadius;
      probe.remove();
      return value;
    };
    const measureShadow = (className: string) => {
      const probe = document.createElement("div");
      probe.className = className;
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      document.body.append(probe);
      const value = getComputedStyle(probe).boxShadow;
      probe.remove();
      return value;
    };
    const widthProbe = document.createElement("div");
    widthProbe.className = "max-w-(--layout-thread-width)";
    widthProbe.style.width = "1000px";
    widthProbe.style.position = "absolute";
    widthProbe.style.visibility = "hidden";
    document.body.append(widthProbe);
    const maxWidth = getComputedStyle(widthProbe).maxWidth;
    widthProbe.remove();
    const h1 = document.createElement("h1");
    const h2 = document.createElement("h2");
    h1.style.position = h2.style.position = "absolute";
    h1.style.visibility = h2.style.visibility = "hidden";
    document.body.append(h1, h2);
    const headingWeights = {
      h1: getComputedStyle(h1).fontWeight,
      h2: getComputedStyle(h2).fontWeight,
    };
    h1.remove();
    h2.remove();
    const sidebar = document.querySelector('[aria-label="Sessions"]');
    const bodyStyle = getComputedStyle(document.body);
    return {
      background: bodyStyle.backgroundColor,
      backgroundToken: resolveToken("--background"),
      foreground: bodyStyle.color,
      foregroundToken: resolveToken("--foreground", "color"),
      primaryToken: resolveToken("--primary"),
      mutedToken: resolveToken("--muted"),
      borderToken: resolveToken("--border", "border-color"),
      sidebarBackground: sidebar ? getComputedStyle(sidebar).backgroundColor : "",
      sidebarToken: resolveToken("--sidebar"),
      typography: {
        sm: measureType("text-sm"),
        md: measureType("text-md"),
        base: measureType("text-base"),
        meta: measureType("text-meta"),
        trace: measureType("font-mono text-trace"),
        code: measureType("font-mono text-code"),
        lg: measureType("text-lg"),
      },
      radii: {
        thread: measureRadius("rounded-thread"),
        surface: measureRadius("rounded-surface"),
        control: measureRadius("rounded-control"),
        md: measureRadius("rounded-md"),
        document: measureRadius("rounded-document"),
      },
      shadows: {
        small: measureShadow("shadow-sm"),
        overlay: measureShadow("shadow-overlay"),
      },
      maxWidth,
      headingWeights,
      publicSansLoaded:
        publicFonts.some((font) => font.family === "Public Sans") &&
        document.fonts.check('16px "Public Sans"'),
      jetBrainsMonoLoaded:
        monoFonts.some((font) => font.family === "JetBrains Mono") &&
        document.fonts.check('12px "JetBrains Mono"'),
      bodyFont: bodyStyle.fontFamily,
      monoFont: measureType("font-mono text-trace").fontFamily,
      dark: document.documentElement.classList.contains("dark"),
    };
  });
  expect(metrics.background).toBe(metrics.backgroundToken);
  expect(metrics.foreground).toBe(metrics.foregroundToken);
  expect(metrics.sidebarBackground).toBe(metrics.sidebarToken);
  expect(metrics.primaryToken).not.toBe("");
  expect(metrics.mutedToken).not.toBe("");
  expect(metrics.borderToken).not.toBe("");
  expect(metrics.dark).toBe(theme === "dark");
  expect(metrics.bodyFont).toContain("Public Sans");
  expect(metrics.monoFont).toContain("JetBrains Mono");
  expect(metrics.publicSansLoaded).toBe(true);
  expect(metrics.jetBrainsMonoLoaded).toBe(true);
  const appOrigin = new URL(page.url()).origin;
  expect(fontRequests.every((url) => new URL(url).origin === appOrigin)).toBe(true);
  expect(fontRequests.some((url) => url.includes("PublicSans") && url.endsWith(".woff2"))).toBe(
    true,
  );
  expect(fontRequests.some((url) => url.includes("JetBrainsMono") && url.endsWith(".woff2"))).toBe(
    true,
  );
  expect(metrics.typography.sm).toMatchObject({ fontSize: "13px", lineHeight: "19.5px" });
  expect(metrics.typography.md).toMatchObject({ fontSize: "15px", lineHeight: "22.5px" });
  expect(metrics.typography.base).toMatchObject({ fontSize: "16px", lineHeight: "24px" });
  expect(metrics.typography.meta).toMatchObject({ fontSize: "11px", lineHeight: "16.5px" });
  expect(metrics.typography.trace).toMatchObject({ fontSize: "12px", lineHeight: "19.5px" });
  expect(metrics.typography.code).toMatchObject({ fontSize: "12.5px", lineHeight: "20.3125px" });
  expect(metrics.typography.lg).toMatchObject({ fontSize: "18px", lineHeight: "28px" });
  expect(metrics.radii).toEqual({
    thread: "16px",
    surface: "10px",
    control: "8px",
    md: "8px",
    document: "6px",
  });
  expect(metrics.shadows.small).toMatch(
    /^(?:rgba\(0, 0, 0, 0\) 0px 0px 0px 0px)(?:, rgba\(0, 0, 0, 0\) 0px 0px 0px 0px)*$/,
  );
  expect(metrics.shadows.overlay).toMatch(
    /^(?:rgba\(0, 0, 0, 0\) 0px 0px 0px 0px)(?:, rgba\(0, 0, 0, 0\) 0px 0px 0px 0px)*$/,
  );
  expect(metrics.maxWidth).toBe("720px");
  expect(metrics.headingWeights).toEqual({ h1: "500", h2: "550" });
}

async function expectPrimaryButton(page: Page): Promise<void> {
  const primary = await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="Send message"]');
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--primary)";
    document.body.append(probe);
    const value = {
      actual: button ? getComputedStyle(button).backgroundColor : "",
      token: getComputedStyle(probe).backgroundColor,
    };
    probe.remove();
    return value;
  });
  expect(primary.actual).toBe(primary.token);
}

async function captureScene(
  scene: string,
  themedPages: Readonly<Record<Theme, ThemedPage>>,
  saveScreenshots: boolean,
): Promise<void> {
  for (const theme of themes) {
    const { page } = themedPages[theme];
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(pageWidth).toBeLessThanOrEqual(viewport.width);
      await waitForFiniteAnimations(page);
      if (saveScreenshots) {
        await page.screenshot({
          path: join(screenshots, `ui-redesign-step2-after-${scene}-${theme}-${viewport.name}.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
    }
  }
}

realTest.use({ seedSessions: 3, seedLongTurn: 20 });

realTest(
  "visual foundation preserves the app flow in both themes and viewport sizes",
  async ({ realApp }, testInfo) => {
    const saveScreenshots = testInfo.repeatEachIndex === 0;
    await mkdir(screenshots, { recursive: true });
    const themedPages = {
      light: await openThemePage(realApp, "light"),
      dark: await openThemePage(realApp, "dark"),
    } satisfies Record<Theme, ThemedPage>;

    for (const theme of themes) {
      const page = themedPages[theme].page;
      await page.setViewportSize({ width: 1280, height: 800 });
      const showSessions = page.getByRole("button", { name: "Show sessions sidebar", exact: true });
      if (await showSessions.isVisible()) await showSessions.click();
      await expect(page.getByRole("listbox", { name: "Session list" })).toBeVisible();
      await assertFoundation(themedPages[theme], theme);
      await page.setViewportSize({ width: 390, height: 844 });
      await assertFoundation(themedPages[theme], theme);
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    await captureScene("sessions-sidebar", themedPages, saveScreenshots);

    for (const theme of themes) {
      const page = themedPages[theme].page;
      await page.setViewportSize({ width: 1280, height: 800 });
      const composer = await startChat(page);
      await expect(composer).toBeVisible();
      expect(await composer.evaluate((element) => getComputedStyle(element).fontSize)).toBe("16px");
      await expectPrimaryButton(page);
    }
    await captureScene("empty-chat", themedPages, saveScreenshots);

    for (const theme of themes) {
      await themedPages[theme].page.setViewportSize({ width: 1280, height: 800 });
      const page = themedPages[theme].page;
      await page
        .getByRole("listbox", { name: "Session list" })
        .getByRole("option", { name: /^Run the long job/ })
        .click();
      await expect(page.getByText("All 20 steps are done.")).toBeVisible({ timeout: 60_000 });
      await openAllToolCards(page);
    }
    await captureScene("long-conversation-tools", themedPages, saveScreenshots);

    for (const theme of themes) {
      await themedPages[theme].page.setViewportSize({ width: 1280, height: 800 });
      const page = themedPages[theme].page;
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    }
    await captureScene("settings-dialog", themedPages, saveScreenshots);

    expect(realApp.problems).toEqual([]);
  },
);
