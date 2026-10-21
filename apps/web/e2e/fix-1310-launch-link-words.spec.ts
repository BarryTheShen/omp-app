import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { expect, realTest, screenshots } from "./real-omp";

/**
 * Issue 1310. A launch link the app never printed read "This launch link has expired", the same screen a
 * link replaced by a restart shows. Now a link the app never printed says it is not valid, and only a link an
 * earlier start printed says it has expired.
 */
// Port 0: the fixture picks a free port and keeps it across a restart, so parallel runs cannot collide on a pinned port.
realTest.use({ serverPort: 0 });
realTest.setTimeout(300_000);

const NOT_VALID = "This launch link is not valid";
const EXPIRED = "This launch link has expired";
const NOT_VALID_HINT =
  "Open the full URL the app printed when it last started, including the part after the #.";

/**
 * Opens the link in a new page with its own storage, so it holds no launch link from an earlier page. Dark
 * mode is chosen the way a person chooses it in Settings: the app saves the choice in local storage, and its
 * page script applies it before the app renders.
 */
async function openLink(
  browser: Browser,
  link: string,
  options: { dark?: boolean; width?: number } = {},
): Promise<{ tab: Page; problems: string[] }> {
  const tab = await browser.newPage();
  const problems: string[] = [];
  tab.on("console", (message) => {
    if (message.type() === "error") problems.push(`console error: ${message.text()}`);
  });
  tab.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  if (options.width !== undefined) await tab.setViewportSize({ width: options.width, height: 844 });
  if (options.dark) {
    await tab.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark"));
  }
  await tab.goto(link);
  return { tab, problems };
}

/**
 * Saves a full-page capture after checking that the stylesheet loaded and that the page is in the theme the
 * file name says, so the file shows the styled screen in that theme.
 */
async function capture(tab: Page, name: string, theme: "light" | "dark"): Promise<void> {
  mkdirSync(screenshots, { recursive: true });
  await expect(tab.getByRole("heading").first()).toHaveCSS("font-weight", "600");
  const dark = await tab.evaluate(() => document.documentElement.classList.contains("dark"));
  expect(dark).toBe(theme === "dark");
  await tab.screenshot({ path: join(screenshots, `${name}.png`), fullPage: true });
}

realTest(
  "a wrong launch link typed into the open tab says it is not valid, and never that it expired",
  async ({ realApp, browser }) => {
    const page = await realApp.open();
    const origin = new URL(page.url()).origin;

    // The address changes only in its fragment, as when a person types a different link into the same tab.
    await page.goto(`${origin}/#token=not-the-token`);
    await expect(page.getByRole("heading", { name: NOT_VALID })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(NOT_VALID_HINT)).toBeVisible();
    await expect(page.getByRole("heading", { name: EXPIRED })).toHaveCount(0);
    await capture(page, "1310-not-valid-light", "light");

    const wrongLink = `${origin}/#token=not-the-token`;
    const dark = await openLink(browser, wrongLink, { dark: true });
    await expect(dark.tab.getByRole("heading", { name: NOT_VALID })).toBeVisible({
      timeout: 30_000,
    });
    await capture(dark.tab, "1310-not-valid-dark", "dark");

    const narrow = await openLink(browser, wrongLink, { width: 390 });
    await expect(narrow.tab.getByRole("heading", { name: NOT_VALID })).toBeVisible({
      timeout: 30_000,
    });
    await capture(narrow.tab, "1310-not-valid-390", "light");
    expect([...dark.problems, ...narrow.problems]).toEqual([]);
    for (const opened of [dark, narrow]) await opened.tab.context().close();
  },
);

realTest(
  "a launch link an earlier start printed says it has expired, in the open tab and in a new one",
  async ({ realApp, browser }) => {
    // While omp-app is stopped the open tab cannot reach it: those connection errors are expected.
    realApp.allowProblem(/WebSocket connection to .* failed/);
    const page = await realApp.open();
    const origin = new URL(page.url()).origin;
    const earlierLink = `${origin}/#token=${realApp.token}`;

    await realApp.restartServer();
    await expect(page.getByRole("heading", { name: EXPIRED })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("heading", { name: NOT_VALID })).toHaveCount(0);
    await expect(
      page.getByText("Open the URL the app printed when it last started."),
    ).toBeVisible();

    // The app printed this link before the restart, so a new tab with it still says it has expired.
    const fresh = await openLink(browser, earlierLink);
    await expect(fresh.tab.getByRole("heading", { name: EXPIRED })).toBeVisible({
      timeout: 90_000,
    });
    await expect(fresh.tab.getByRole("heading", { name: NOT_VALID })).toHaveCount(0);
    await capture(fresh.tab, "1310-expired-light", "light");

    const dark = await openLink(browser, earlierLink, { dark: true });
    await expect(dark.tab.getByRole("heading", { name: EXPIRED })).toBeVisible({ timeout: 90_000 });
    await capture(dark.tab, "1310-expired-dark", "dark");

    const narrow = await openLink(browser, earlierLink, { width: 390 });
    await expect(narrow.tab.getByRole("heading", { name: EXPIRED })).toBeVisible({
      timeout: 90_000,
    });
    await capture(narrow.tab, "1310-expired-390", "light");
    expect([...fresh.problems, ...dark.problems, ...narrow.problems]).toEqual([]);
    for (const opened of [fresh, dark, narrow]) await opened.tab.context().close();
  },
);
