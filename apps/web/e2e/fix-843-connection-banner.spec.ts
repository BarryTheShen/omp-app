import { join } from "node:path";
import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

realTest.use({ seedLongTurn: 60 });

const DRAFT = "draft that must survive the drop";
const BANNER = "Connection lost. Reconnecting to omp-app…";
const UNREACHABLE =
  "omp-app is not answering. Check that it is still running, then reload this page.";
const BLOCKED = "Can't send yet. Your message stays here until omp-app reconnects.";

/** The page's socket: the live sockets a drop closes, and the reconnects refused while the outage lasts. */
interface Tab {
  outage: boolean;
  refused: number;
  readonly live: WebSocketRoute[];
}

/**
 * Routes the page's WebSocket through the test. `context.setOffline` leaves an open WebSocket alone, so the drop
 * closes the socket here, and each reconnect is refused while the outage lasts.
 */
function routeSocket(target: Page, tab: Tab): Promise<void> {
  return target.routeWebSocket(/\/ws(\?|$)/, async (socket) => {
    if (tab.outage) {
      tab.refused += 1;
      await socket.close();
      return;
    }
    socket.connectToServer();
    tab.live.push(socket);
  });
}

/** The drop: the page's live sockets close, and every reconnect is refused until the outage ends. */
async function dropConnection(tab: Tab): Promise<void> {
  tab.outage = true;
  for (const socket of tab.live.splice(0)) await socket.close();
}

/** The reader's place is read once the rows around it stop being measured: far rows settle as they come into view. */
async function settledScrollTop(viewport: Locator): Promise<number> {
  let previous = "";
  let same = 0;
  await expect
    .poll(
      async () => {
        const now = await viewport.evaluate(
          (element) => `${Math.round(element.scrollTop)}/${element.scrollHeight}`,
        );
        same = now === previous ? same + 1 : 0;
        previous = now;
        return same;
      },
      { intervals: [300], timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(3);
  return scrollTop(viewport);
}

function scrollTop(viewport: Locator): Promise<number> {
  return viewport.evaluate((element) => element.scrollTop);
}

/** The banner sits on screen: a banner wider than the screen would be cut off. */
async function expectInsideScreen(locator: Locator, screenWidth: number): Promise<void> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("The banner is not on screen.");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(screenWidth);
}

/**
 * Issue #843. A dropped connection replaced the whole page with a "Connecting to omp-app" screen about a second and
 * a half after the drop, so the chat, the draft and the reader's place went with it. Now, with a chat open:
 * - a short banner stays over the chat while the app reconnects, and the draft and the reader's place stay;
 * - the composer says it cannot send yet, and Send is off until the connection is back;
 * - after 30 seconds of failed tries the banner says what to do and where the log is;
 * - the app reconnects by itself: the note goes and the draft sends.
 */
realTest(
  "a dropped connection keeps the chat, the draft and the reader's place on screen until the app reconnects",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(420_000);
    // The browser reports each refused connection while the app is unreachable: expected here.
    realApp.allowProblem(/WebSocket connection to .* failed/);
    const tab: Tab = { outage: false, refused: 0, live: [] };
    const page = await realApp.open({ beforeLoad: (target) => routeSocket(target, tab) });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /Run the long job/ })
      .click();

    const viewport = page.getByRole("region", { name: "Messages" });
    const composer = page.getByRole("textbox", { name: "Message input" });
    const send = page.getByRole("button", { name: "Send message" });
    const banner = page.locator("[data-connection-banner='true']");
    await expect(page.getByText("All 60 steps are done.")).toBeAttached({ timeout: 60_000 });

    // A reader scrolls up into the middle of the chat and has typed a draft.
    await viewport.hover();
    await page.mouse.wheel(0, -1_500);
    await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
    await composer.fill(DRAFT);
    const reader = await settledScrollTop(viewport);

    await dropConnection(tab);
    await expect(page.getByText(BANNER, { exact: true })).toBeVisible({ timeout: 10_000 });
    // The full-page screen used to appear about 1.5 seconds after the drop: wait for several refused tries, then look again.
    await expect.poll(() => tab.refused, { timeout: 20_000 }).toBeGreaterThanOrEqual(4);
    await expect(page.getByRole("heading", { name: "Connecting to omp-app" })).toHaveCount(0);
    await expect(viewport).toBeVisible();
    await expect(page.getByText("All 60 steps are done.")).toBeAttached();
    await expect(page.getByText(BANNER, { exact: true })).toBeVisible();
    await expect(composer).toHaveValue(DRAFT);
    await expect(page.getByText(BLOCKED, { exact: true })).toBeVisible();
    await expect(composer).toHaveAccessibleDescription(BLOCKED);
    await expect(send).toBeDisabled();
    expect(Math.abs((await scrollTop(viewport)) - reader)).toBeLessThan(2);

    // Styles are loaded before the screenshots: tokens, not browser defaults.
    await expect(page.locator("body")).toHaveCSS("background-color", /^(rgb|oklch)/);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-843-connection-banner-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("body")).toHaveCSS("background-color", /^(rgb|oklch)/);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-843-connection-banner-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(composer).toHaveValue(DRAFT);
    await expect(page.getByText(BANNER, { exact: true })).toBeVisible();
    await expectInsideScreen(banner, 390);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-843-connection-banner-narrow.png") });

    // After 30 seconds of failed tries the banner says what to do and where the log is; the chat stays as it was.
    await expect(page.getByText(UNREACHABLE, { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(BANNER, { exact: true })).toHaveCount(0);
    await expect(banner.locator("[data-log-hint='true']")).toContainText("omp-app logs");
    await expect(composer).toHaveValue(DRAFT);
    await expect(page.getByText(BLOCKED, { exact: true })).toBeVisible();
    expect(Math.abs((await scrollTop(viewport)) - reader)).toBeLessThan(2);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-843-connection-unreachable-narrow.png") });
    await page.setViewportSize({ width: 320, height: 640 });
    await expectInsideScreen(banner, 320);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-843-connection-unreachable-320.png") });

    // The app reconnects by itself: the banner and the note go, the draft stays, and sending works again.
    await page.setViewportSize({ width: 1280, height: 900 });
    tab.outage = false;
    await expect(page.getByText(UNREACHABLE, { exact: true })).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText(BLOCKED, { exact: true })).toBeHidden();
    await expect(composer).toHaveValue(DRAFT);
    await expect(send).toBeEnabled();
    expect(Math.abs((await scrollTop(viewport)) - reader)).toBeLessThan(2);
    await composer.press("Enter");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
  },
);

/**
 * A drop with no chat open. The empty shell has no composer, so the banner sits at the bottom of its transcript,
 * and a new chat works once the app is back.
 */
realTest(
  "a dropped connection with no chat open shows the banner, and a new chat works after the reconnect",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    realApp.allowProblem(/WebSocket connection to .* failed/);
    const tab: Tab = { outage: false, refused: 0, live: [] };
    const page = await realApp.open({ beforeLoad: (target) => routeSocket(target, tab) });
    await expect(page.getByRole("textbox", { name: "Message input" })).toHaveCount(0);

    await dropConnection(tab);
    const banner = page.getByText(BANNER, { exact: true });
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => tab.refused, { timeout: 20_000 }).toBeGreaterThanOrEqual(4);
    await expect(page.getByRole("heading", { name: "Connecting to omp-app" })).toHaveCount(0);
    await expect(banner).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-843-connection-banner-empty-shell.png") });

    tab.outage = false;
    await expect(banner).toBeHidden({ timeout: 30_000 });
    // The sidebar's list failed while the app was down, and it loads again once the app is back.
    await expect(page.getByRole("option", { name: /Run the long job/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
    const composer = await startChat(page);
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
  },
);
