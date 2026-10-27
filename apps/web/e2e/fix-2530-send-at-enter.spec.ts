import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import {
  expect,
  narrowTo,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

declare global {
  interface Window {
    /** On the page's clock: when the Enter key went down, and the frame that first shows the prompt's row. */
    sendProbe?: { enterAt?: number; rowAt?: number };
    /** The row element the prompt showed at Enter, kept so the echo can be checked to take the same element. */
    pendingRowNode?: Element;
  }
}

/*
 * Issue 2530 (SP-S1): a plain prompt shows its row at Enter, before omp answers. omp's echo of the prompt then takes
 * that row's place, on the same element. The frames omp sends are held inside the page (routeWebSocket), so the check
 * sees the chat between Enter and the echo, and the echo arrives afterwards. Nothing is sent to omp but what the app
 * sends. Real omp on the test machine (omp 18.12.1, `omp --version`). On main the row waits for the echo, so cases 1 and 2 fail there.
 */

const PROMPT = "Name one reason a sent message should show at once, in one short sentence.";
const USER_ROW = '[data-slot="u1-message-row"][data-role="user"]';
const PENDING_KEY = 'data-store-key*="pending-prompt"';
const DRAFT_PORT = "A1.draftStore";
const NOTICE = "It's in the message box of a new chat";
const SHOWN_WITHIN_MS = 150;

interface Frame {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly port?: unknown;
  readonly method?: unknown;
  readonly args?: { readonly method?: unknown };
}

/** The frames omp sends after the prompt, held until `release`, in the order they came. */
class FrameHold {
  holding = false;
  private readonly queued: Array<() => void> = [];

  hold(send: () => void): void {
    this.queued.push(send);
  }

  release(): void {
    this.holding = false;
    for (const send of this.queued.splice(0)) send();
  }
}

function parseFrame(message: string | Buffer): Frame | undefined {
  try {
    return JSON.parse(String(message)) as Frame;
  } catch {
    return undefined;
  }
}

/**
 * Routes the page's websocket. From the prompt's send on, omp's event frames are held, and so is any frame that carries
 * the prompt's text (the echo). The draft store's own calls and answers pass through, so the composer clears when omp
 * admits the prompt, which is not held.
 */
async function holdEchoFrames(target: Page, hold: FrameHold): Promise<void> {
  await target.routeWebSocket(/\/ws/, (ws: WebSocketRoute) => {
    const server = ws.connectToServer();
    const draftCalls = new Set<string>();
    ws.onMessage((message) => {
      const frame = parseFrame(message);
      if (frame?.type === "call" && frame.port === DRAFT_PORT) draftCalls.add(String(frame.id));
      if (
        frame?.type === "call" &&
        frame.port === "A0.chatSession" &&
        frame.method === "request" &&
        frame.args?.method === "prompt"
      ) {
        hold.holding = true;
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = parseFrame(message);
      const text = String(message);
      const draftOwn =
        frame?.type === "result"
          ? draftCalls.has(String(frame.id))
          : text.includes(`"${DRAFT_PORT}/`);
      if (hold.holding && !draftOwn && (frame?.type === "event" || text.includes(PROMPT))) {
        hold.hold(() => ws.send(message));
        return;
      }
      ws.send(message);
    });
  });
}

/** Times the send in the page: from its Enter key to the frame that first shows the prompt's row. */
async function watchSend(page: Page, text: string): Promise<void> {
  await page.evaluate((prompt) => {
    const probe: NonNullable<Window["sendProbe"]> = {};
    window.sendProbe = probe;
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter" && probe.enterAt === undefined) probe.enterAt = performance.now();
      },
      true,
    );
    const rowOnScreen = (): boolean =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-slot="u1-message-row"][data-role="user"]'),
      ).some((row) => row.textContent?.includes(prompt) === true);
    new MutationObserver(() => {
      if (probe.rowAt !== undefined || !rowOnScreen()) return;
      requestAnimationFrame(() => {
        probe.rowAt ??= performance.now();
      });
    }).observe(document.body, { childList: true, subtree: true });
  }, text);
}

/** Enter to the prompt's row on screen, in milliseconds on the page's clock. Fails when the row never shows. */
async function enterToRow(page: Page): Promise<number> {
  await page.waitForFunction(() => window.sendProbe?.rowAt !== undefined, undefined, {
    timeout: 5_000,
  });
  return page.evaluate(() => (window.sendProbe?.rowAt ?? 0) - (window.sendProbe?.enterAt ?? 0));
}

/** The composer's background is the design token's, so the app's styles have loaded before a screenshot. */
async function expectPainted(page: Page): Promise<void> {
  const colors = await page.evaluate(() => {
    const section = document.querySelector('[data-shell-region="composer"]');
    const probe = document.createElement("div");
    probe.className = "bg-background";
    document.body.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { section: section ? getComputedStyle(section).backgroundColor : "", token };
  });
  expect(colors.token).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.section).toBe(colors.token);
}

/**
 * Sends the prompt while omp's echo is held, then checks the chat between Enter and the echo: the row shows within the
 * budget, it is the only row with the text, and it offers no Edit or Regenerate action (omp has not saved it yet).
 */
async function sendWhileEchoHeld(
  page: Page,
  composer: Locator,
  hold: FrameHold,
  shot: string,
): Promise<void> {
  await watchSend(page, PROMPT);
  await composer.fill(PROMPT);
  await composer.press("Enter");
  expect(await enterToRow(page), "Enter to the row on screen, in milliseconds").toBeLessThanOrEqual(
    SHOWN_WITHIN_MS,
  );
  await expect.poll(() => hold.holding).toBe(true);
  const row = page.locator(USER_ROW).filter({ hasText: PROMPT });
  await expect(row).toHaveCount(1);
  await expect(page.locator(USER_ROW)).toHaveCount(1);
  await expect(page.locator(`${USER_ROW}[${PENDING_KEY}]`)).toHaveCount(1);
  await expect(row.getByRole("button", { name: /^(Edit|Regenerate)/ })).toHaveCount(0);
  // Keeps the element, so the check after the echo can tell it is the same one.
  await row.evaluate((node) => {
    window.pendingRowNode = node;
  });
  // The composer clears once omp admits the prompt, which is not the held echo.
  await expect(composer).toHaveValue("", { timeout: 60_000 });
  await waitForFiniteAnimations(page);
  await expectPainted(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, `${shot}.png`), fullPage: true });
}

/** Lets omp's frames through: the echo takes the row the prompt showed at Enter, the same element, and no second row. */
async function echoArrives(page: Page, hold: FrameHold): Promise<void> {
  hold.release();
  // The echo has landed once the only row with the text no longer carries the key of its pending row.
  await expect(page.locator(`${USER_ROW}:not([${PENDING_KEY}])`)).toHaveCount(1, {
    timeout: 60_000,
  });
  await expect(page.locator(USER_ROW)).toHaveCount(1);
  await expect(page.locator(USER_ROW)).toContainText(PROMPT);
  const sameElement = await page
    .locator(USER_ROW)
    .evaluate((node) => window.pendingRowNode === node);
  expect(sameElement, "the echo takes the row element shown at Enter").toBe(true);
}

/**
 * The refused send of #2358: a send from a New chat that has not opened yet, refused when the person starts another New
 * chat at once. The notice says where the text went; the text is in the message box of the new chat.
 */
async function refusedSendInNewChat(page: Page): Promise<Locator> {
  const first = await startChat(page);
  await sendPrompt(first, "first chat");
  await expect(
    page.locator('[data-slot="u1-message-row"][data-role="assistant"]').last(),
  ).toContainText("pong", { timeout: 90_000 });
  const composer = await startChat(page);
  await sendPrompt(composer, PROMPT);
  const next = await startChat(page);
  await expect(page.getByText(NOTICE, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-empty-chat="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(next).toHaveValue(PROMPT);
  return next;
}

realTest(
  "a sent prompt shows its row at Enter, before omp's echo, and the echo takes that row (light, 1280 px)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const hold = new FrameHold();
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light"));
        await holdEchoFrames(target, hold);
      },
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChat(page);
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await sendWhileEchoHeld(page, composer, hold, "fix-2530-pending-light-1280");
    await echoArrives(page, hold);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the same send in dark theme, at 1280 px: the row shows at Enter, and the echo takes it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const hold = new FrameHold();
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark"));
        await holdEchoFrames(target, hold);
      },
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChat(page);
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await sendWhileEchoHeld(page, composer, hold, "fix-2530-pending-dark-1280");
    await echoArrives(page, hold);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the same send on a phone, at 390 px: the row shows at Enter, and the echo takes it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const hold = new FrameHold();
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light"));
        await holdEchoFrames(target, hold);
      },
    });
    const composer = await startChat(page);
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await narrowTo(page, { width: 390, height: 844 });
    await sendWhileEchoHeld(page, composer, hold, "fix-2530-pending-narrow-390");
    await echoArrives(page, hold);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a refused send leaves no row, and its text is back in the composer with the notice (light, 1280 px)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    const next = await refusedSendInNewChat(page);
    await expect(page.locator(USER_ROW).filter({ hasText: PROMPT })).toHaveCount(0);
    await expect(next).toHaveValue(PROMPT);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a refused send leaves no row, and its text and notice are still there at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    const next = await refusedSendInNewChat(page);
    await narrowTo(page, { width: 390, height: 844 });
    await expect(page.getByText(NOTICE, { exact: false }).first()).toBeVisible();
    await expect(page.locator(USER_ROW).filter({ hasText: PROMPT })).toHaveCount(0);
    await expect(next).toHaveValue(PROMPT);
    expect(realApp.problems).toEqual([]);
  },
);
