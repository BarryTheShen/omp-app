import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { realTest, screenshots, sendPrompt, startChat, waitForFiniteAnimations } from "./real-omp";

const WIDE = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

realTest.use({ seedSessions: 2 });

async function probeBackground(page: Page, value: string): Promise<string> {
  return page.evaluate((background) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = background;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return resolved;
  }, value);
}

async function probeColor(page: Page, value: string): Promise<string> {
  return page.evaluate((color) => {
    const probe = document.createElement("span");
    probe.style.color = color;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, value);
}

async function shellMeasurements(page: Page) {
  return page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>('[data-shell-sidebar="left"]');
    const header = document.querySelector<HTMLElement>('[data-shell-region="header"]');
    const railHeader = rail?.firstElementChild;
    if (!rail || !header || !(railHeader instanceof HTMLElement)) {
      throw new Error("shell measurements found no shell");
    }
    const buttons = Array.from(rail.querySelectorAll<HTMLElement>("button"));
    const newChat = buttons.find((button) => button.textContent?.includes("New chat"));
    const search = rail.querySelector<HTMLElement>('[aria-label="Search sessions"]');
    const sessionRow = rail.querySelector<HTMLElement>('[data-slot="r1-session-row"]');
    const groupHeading = rail.querySelector<HTMLElement>("h3");
    const title = header.querySelector<HTMLElement>("h1");
    const settings = header.querySelector<HTMLElement>('button[aria-label="Settings"]');
    const composer = document.querySelector<HTMLElement>('[data-shell-region="composer"]');
    const status = document.querySelector<HTMLElement>('[data-shell-region="status"]');
    if (
      !newChat ||
      !search ||
      !sessionRow ||
      !groupHeading ||
      !title ||
      !settings ||
      !composer ||
      !status
    ) {
      throw new Error("shell measurements found missing rail or header elements");
    }
    const railLeft = rail.getBoundingClientRect().left;
    const railRight = rail.getBoundingClientRect().right;
    const headerLeft = header.getBoundingClientRect().left;
    const headerRight = header.getBoundingClientRect().right;
    const newChatRect = newChat.getBoundingClientRect();
    const searchRect = search.getBoundingClientRect();
    const rowRect = sessionRow.getBoundingClientRect();
    const headingText = groupHeading.firstElementChild;
    const headingRect = (
      headingText instanceof HTMLElement ? headingText : groupHeading
    ).getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const settingsRect = settings.getBoundingClientRect();
    const newChatText = Array.from(newChat.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE,
    );
    const logo = railHeader.querySelector<HTMLImageElement>('img[src="/favicon.svg"]');
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--sidebar)";
    document.body.append(probe);
    const railToken = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const labelRange = document.createRange();
    if (newChatText) labelRange.selectNodeContents(newChatText);
    const labelRect = labelRange.getBoundingClientRect();
    return {
      railWidth: rail.getBoundingClientRect().width,
      railHeight: rail.getBoundingClientRect().height,
      railHeaderHeight: railHeader.getBoundingClientRect().height,
      railHeaderBorder: getComputedStyle(railHeader).borderBottomWidth,
      headerHeight: header.getBoundingClientRect().height,
      newChatWidth: newChatRect.width,
      newChatHeight: newChatRect.height,
      newChatRadius: getComputedStyle(newChat).borderTopLeftRadius,
      newChatBorder: getComputedStyle(newChat).borderTopWidth,
      newChatLeft: newChatRect.left - railLeft,
      newChatRight: railRight - newChatRect.right,
      newChatLabelLeft: labelRect.left - railLeft,
      newChatBackground: getComputedStyle(newChat).backgroundColor,
      searchLeft: searchRect.left - railLeft,
      searchRight: railRight - searchRect.right,
      rowLeft: rowRect.left - railLeft,
      rowRight: railRight - rowRect.right,
      headingLeft: headingRect.left - railLeft,
      titleLeft: titleRect.left - headerLeft,
      settingsRight: headerRight - settingsRect.right,
      composerBorder: getComputedStyle(composer).borderTopWidth,
      statusBorder: getComputedStyle(status).borderTopWidth,
      railBackground: getComputedStyle(rail).backgroundColor,
      railToken,
      logoLoaded: logo !== null && logo.naturalWidth > 0,
    };
  });
}

async function expectAccessibleShellChrome(page: Page): Promise<void> {
  await expect(page.getByRole("navigation", { name: "Sessions" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Panels" })).toBeVisible();
  await expect(page.getByLabel("Workspace folder")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search sessions" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "System" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Light" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Dark" })).toBeVisible();
  const hideSessions = page.getByRole("button", { name: "Hide sessions sidebar" });
  const hidePanels = page.getByRole("button", { name: "Hide panels sidebar" });
  for (const toggle of [hideSessions, hidePanels]) {
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveAttribute("aria-controls", /shell-(sessions|panels)-sidebar/);
  }
  await expect(hideSessions).toHaveAttribute("aria-label", "Hide sessions sidebar");
  await expect(hideSessions).toHaveAttribute("title", "Hide sessions sidebar");
  await expect(hidePanels).toHaveAttribute("aria-label", "Hide panels sidebar");
  await expect(hidePanels).toHaveAttribute("title", "Hide panels sidebar");
  await expect(page.getByRole("button", { name: /More actions for/ }).first()).toBeVisible();
  await expect(hideSessions.locator("svg")).toHaveClass(/lucide-panel-left/);
  await expect(hidePanels.locator("svg")).toHaveClass(/lucide-panel-right/);
}

async function expectSessionRowStyles(page: Page): Promise<void> {
  const rows = page.locator('[data-slot="r1-session-row"]');
  await expect(rows).toHaveCount(2);
  const first = rows.first();
  const second = rows.nth(1);
  const firstOption = first.getByRole("option");
  const secondOption = second.getByRole("option");
  await expect(firstOption).toBeVisible();
  await expect(secondOption).toBeVisible();
  expect(
    await first.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(32);
  expect(await first.evaluate((element) => getComputedStyle(element).borderTopLeftRadius)).toBe(
    "8px",
  );

  const hoverBackground = await probeBackground(
    page,
    "color-mix(in oklab, var(--foreground) 4%, transparent)",
  );
  const selectedBackground = await probeBackground(
    page,
    "color-mix(in oklab, var(--foreground) 6%, transparent)",
  );
  const foreground = await probeColor(page, "var(--foreground)");
  const mutedForeground = await probeColor(page, "var(--muted-foreground)");

  await first.hover();
  await expect(first).toHaveCSS("background-color", hoverBackground);
  const hover = await first.evaluate((element) => {
    const inner = element.firstElementChild;
    return {
      outer: getComputedStyle(element).backgroundColor,
      inner: inner instanceof HTMLElement ? getComputedStyle(inner).backgroundColor : "",
    };
  });
  expect(hover.outer).toBe(hoverBackground);
  expect(hover.inner).toBe("rgba(0, 0, 0, 0)");

  await firstOption.click();
  await expect(first).toHaveAttribute("data-selected", "true");
  await expect(first).toHaveCSS("background-color", selectedBackground);
  const selected = await first.evaluate((element) => {
    const inner = element.firstElementChild;
    return {
      outer: getComputedStyle(element).backgroundColor,
      inner: inner instanceof HTMLElement ? getComputedStyle(inner).backgroundColor : "",
    };
  });
  expect(selected.outer).toBe(selectedBackground);
  expect(selected.inner).toBe("rgba(0, 0, 0, 0)");
  const selectedTitle = firstOption.locator(":scope > div > div").first();
  const otherTitle = secondOption.locator(":scope > div > div").first();
  expect(await selectedTitle.evaluate((element) => getComputedStyle(element).color)).toBe(
    foreground,
  );
  expect(await otherTitle.evaluate((element) => getComputedStyle(element).color)).toBe(
    mutedForeground,
  );
}

for (const theme of ["light", "dark"] as const) {
  realTest(
    `Step 3 shell matches the measured columns at wide and phone widths (${theme})`,
    async ({ realApp }) => {
      const page = await realApp.open({
        beforeLoad: (target) =>
          target.addInitScript(
            (value: string) => window.localStorage.setItem("omp-app.theme", value),
            theme,
          ),
      });
      await page.setViewportSize(WIDE);
      await expect(page.locator('[data-shell-layout="wide"]')).toHaveCount(1);
      await expect(page.getByText("omp", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "New conversation" })).toBeVisible();
      await expect(page.locator('[data-shell-region="header"] h1')).toHaveCount(1);
      await expect(
        page.locator('[data-shell-region="header"]').getByText("omp", { exact: true }),
      ).toHaveCount(0);
      await expectAccessibleShellChrome(page);
      const settings = page.getByRole("button", { name: "Settings", exact: true });
      await expect(settings.locator("svg")).toBeVisible();
      await expect(settings.locator(":scope > :not(.sr-only)")).toHaveCount(1);
      const wide = await shellMeasurements(page);
      expect(wide.railWidth).toBeCloseTo(240, 0);
      expect(wide.railHeight).toBe(800);
      expect(wide.railHeaderHeight).toBe(48);
      expect(wide.railHeaderBorder).toBe("1px");
      expect(wide.headerHeight).toBe(48);
      expect(wide.newChatWidth).toBeCloseTo(215, 0);
      expect(wide.newChatHeight).toBe(32);
      expect(wide.newChatRadius).toBe("8px");
      expect(wide.newChatBorder).toBe("1px");
      expect(wide.newChatLeft).toBeCloseTo(12, 0);
      expect(wide.newChatRight).toBeCloseTo(13, 0);
      expect(wide.newChatLabelLeft).toBeCloseTo(45, 0);
      expect(wide.newChatBackground).toBe(await probeBackground(page, "var(--background)"));
      expect(wide.searchLeft).toBeCloseTo(14, 0);
      expect(wide.searchRight).toBeCloseTo(15, 0);
      expect(wide.rowLeft).toBeCloseTo(12, 0);
      expect(wide.rowRight).toBeCloseTo(13, 0);
      expect(wide.headingLeft).toBeCloseTo(20, 0);
      expect(wide.titleLeft).toBeCloseTo(20, 0);
      expect(wide.settingsRight).toBeCloseTo(20, 0);
      expect(wide.composerBorder).toBe("0px");
      expect(wide.statusBorder).toBe("0px");
      expect(wide.railBackground).toBe(wide.railToken);

      await expectSessionRowStyles(page);
      await page.getByRole("button", { name: "Hide sessions sidebar" }).click();
      const showSessions = page.getByRole("button", { name: "Show sessions sidebar" });
      await expect(showSessions).toBeVisible();
      await expect(showSessions).toHaveAttribute("aria-expanded", "false");
      await expect(showSessions).toHaveAttribute("aria-controls", "shell-sessions-sidebar");
      await expect(showSessions).toHaveAttribute("title", "Show sessions sidebar");
      const collapsedSessionHeader = page.locator('[data-shell-sidebar-collapse="left"]');
      await expect(collapsedSessionHeader).toHaveAttribute("aria-expanded", "false");
      await expect(collapsedSessionHeader).toHaveAttribute("aria-label", "Show sessions sidebar");
      await expect(collapsedSessionHeader).toHaveAttribute("title", "Show sessions sidebar");
      await page.getByRole("button", { name: "Hide panels sidebar" }).click();
      await expect(page.getByRole("button", { name: "Show panels sidebar" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Show panels sidebar" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await expect(page.getByRole("button", { name: "Show panels sidebar" })).toHaveAttribute(
        "aria-controls",
        "shell-panels-sidebar",
      );

      const composer = await startChat(page);
      await sendPrompt(composer, "pong");
      await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
      const toolbar = page.locator('[data-layout-area="composerToolbar"]');
      await expect(toolbar.locator('[data-surface="model"]')).toHaveCount(1);
      await expect(toolbar.locator(":scope > [data-surface]").first()).toHaveAttribute(
        "data-surface",
        "model",
      );
      await expect(page.locator('[data-shell-region="header"] [data-surface="model"]')).toHaveCount(
        0,
      );
      await expect(composer).toBeVisible();

      await mkdir(screenshots, { recursive: true });
      await waitForFiniteAnimations(page);
      await page.screenshot({
        path: join(screenshots, `s3-shell-${theme}-wide.png`),
        fullPage: true,
      });
      await page.setViewportSize(PHONE);
      await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
      await expect(showSessions).toBeVisible();
      await expect(showSessions).toHaveAttribute("title", "Show sessions sidebar");
      await expect(page.getByRole("button", { name: "Show panels sidebar" })).toBeVisible();
      await showSessions.click();
      const drawer = page.locator('[data-shell-sidebar="left"]');
      await expect(drawer).toBeVisible();
      await expect(drawer).toHaveCSS("width", "288px");
      await expect(drawer.locator('[data-shell-sidebar-collapse="left"]')).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await expect(drawer.locator('[data-shell-sidebar-collapse="left"]')).toHaveAttribute(
        "aria-label",
        "Hide sessions sidebar",
      );
      await expect(drawer.locator('[data-shell-sidebar-collapse="left"]')).toHaveAttribute(
        "title",
        "Hide sessions sidebar",
      );
      const phone = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(phone.scrollWidth).toBeLessThanOrEqual(phone.clientWidth);
      await page.screenshot({
        path: join(screenshots, `s3-shell-${theme}-phone.png`),
        fullPage: true,
      });
      expect(realApp.problems).toEqual([]);
    },
  );
}
