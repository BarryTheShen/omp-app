import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import {
  expect,
  narrowTo,
  realTest,
  screenshots,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

declare global {
  interface Window {
    /** The row element the prompt showed at Enter, kept so the echo can be checked to take the same element. */
    pendingRowNode?: Element;
  }
}

/*
 * Issue 2307 (part of 2217): the greeting and the centred composer of an empty chat left when omp's echo of the first
 * prompt reached the transcript. On a busy machine that came long after Enter, and row 7 of the motion audit counted the
 * jump as a layout shift no input caused. A message now ends the empty chat when it is sent. This holds back omp's events,
 * and every frame that carries the prompt's text, so the check sees the chat between Enter and the echo. Real omp 18.12.2
 * on the test machine.
 */

// omp 18.12.2 is at this path in every the test machine job.
realTest.use({ ompBinary: "/cache/bun/omp-18.12.2" });

const PROMPT = "Please write a short answer for the layout check.";
const USER_ROW = '[data-slot="u1-message-row"][data-role="user"]';
const DRAFT_PORT = "A1.draftStore";

interface Frame {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly port?: unknown;
  readonly method?: unknown;
  readonly args?: { readonly command?: { readonly type?: unknown } };
}

/** The frames held from the prompt's send until `release`, in the order they came. */
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
 * Routes the page's websocket. From the prompt's send on, omp's events are held, and so is any frame that carries the
 * prompt's text: omp's echo is an event, and the history omp writes for the prompt reaches the transcript as a result.
 * The draft store's own answers and events pass through: they are the composer's draft, which clears after the send.
 */
async function holdPromptFrames(target: Page, hold: FrameHold): Promise<void> {
  await target.routeWebSocket(/\/ws/, (ws: WebSocketRoute) => {
    const server = ws.connectToServer();
    const draftCalls = new Set<string>();
    ws.onMessage((message) => {
      const frame = parseFrame(message);
      if (frame?.type === "call" && frame.port === DRAFT_PORT) draftCalls.add(String(frame.id));
      if (
        frame?.type === "call" &&
        frame.method === "send" &&
        frame.args?.command?.type === "prompt"
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

/** The composer's section: the composer and its place in the layout. */
function composerSection(page: Page): Locator {
  return page.locator('[data-shell-region="composer"]');
}

async function boxOf(locator: Locator): Promise<{ readonly y: number; readonly height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("the element is not rendered");
  return box;
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
 * Sends the prompt from the empty chat while the prompt's frames are held, then checks the chat between Enter and the echo:
 * the greeting is gone, the composer has moved down, the text was sent, and the prompt's row is shown before the echo.
 */
async function sendWhileEchoHeld(
  page: Page,
  composer: Locator,
  hold: FrameHold,
  shot: string,
): Promise<void> {
  const before = await boxOf(composerSection(page));
  await composer.fill(PROMPT);
  await composer.press("Enter");
  await expect(page.getByText("No messages yet.")).toHaveCount(0);
  await expect(page.locator('[data-empty-chat="true"]')).toHaveCount(0);
  // The composer clears once omp admits the prompt, which takes 0.2 to 2 s on the test machine under load (not the held echo).
  await expect(composer).toHaveValue("", { timeout: 60_000 });
  // The prompt's row shows at Enter, while omp's echo is held; the echo takes this same row (see echoArrives).
  await expect(page.locator(USER_ROW)).toHaveCount(1);
  await expect(page.locator(USER_ROW)).toContainText(PROMPT);
  await page.locator(USER_ROW).evaluate((row) => {
    window.pendingRowNode = row;
  });
  // "Edit an earlier message" waits for omp's echo: the pending row is not an earlier message yet.
  await expect(editEarlier(page)).toBeHidden();
  expect(hold.holding, "the prompt's frames are still held").toBe(true);
  await waitForFiniteAnimations(page);
  const after = await boxOf(composerSection(page));
  expect(after.y - before.y, "the composer moved down when the prompt was sent").toBeGreaterThan(
    150,
  );
  await expectPainted(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, `${shot}.png`), fullPage: true });
}

/** Lets the held frames through: the echo takes the row the prompt showed at Enter, and the label opens once it has. */
async function echoArrives(page: Page, hold: FrameHold): Promise<void> {
  hold.release();
  await expect(editEarlier(page)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(USER_ROW)).toHaveCount(1);
  const sameRow = await page.locator(USER_ROW).evaluate((row) => window.pendingRowNode === row);
  expect(sameRow, "the echo takes the row shown at Enter, not a second row").toBe(true);
}

/** The label that opens the picker of earlier messages (P3's selector). */
function editEarlier(page: Page): Locator {
  return page.getByRole("button", { name: "Edit an earlier message" });
}

realTest(
  "a sent prompt ends the empty chat before its echo arrives, and the composer moves down at Enter (light, 1280 px)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const hold = new FrameHold();
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light"));
        await holdPromptFrames(target, hold);
      },
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChat(page);
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await sendWhileEchoHeld(page, composer, hold, "fix-2307-held-light-1280");
    await echoArrives(page, hold);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2307-echoed-light-1280.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the same send in dark theme, at 1280 px: the greeting goes at Enter and the echo arrives after",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const hold = new FrameHold();
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark"));
        await holdPromptFrames(target, hold);
      },
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChat(page);
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await sendWhileEchoHeld(page, composer, hold, "fix-2307-held-dark-1280");
    await echoArrives(page, hold);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the same send on a phone, at 390 px: the greeting goes at Enter and the echo arrives after",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const hold = new FrameHold();
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light"));
        await holdPromptFrames(target, hold);
      },
    });
    const composer = await startChat(page);
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await narrowTo(page, { width: 390, height: 844 });
    await sendWhileEchoHeld(page, composer, hold, "fix-2307-held-narrow-390");
    await echoArrives(page, hold);
    expect(realApp.problems).toEqual([]);
  },
);
