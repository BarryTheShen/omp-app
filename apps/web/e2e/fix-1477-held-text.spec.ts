import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import {
  expect,
  REAL_OMP,
  realTest,
  screenshots,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue #1477. A held send keeps its text in the composer. In a new chat the text is first kept in the chat's own
 * draft and then moved to the folder's new-chat draft once the chat has loaded. A text typed while that move waits at
 * the store was dropped, and the composer then showed the held command again over it. The spec holds the two store
 * answers that make the move wait, types into the composer while it waits, and checks what the person sees.
 */

/** omp's command list cannot be read in these runs: the proxy beside this spec answers its request with an error. */
const PROXY = resolve(process.cwd(), "e2e/fix-1371-omp-without-command-list.ts");
const wrapperDir = resolve(process.cwd(), "../../.data/fix-1371-command-list");
mkdirSync(wrapperDir, { recursive: true });
const wrapper = join(wrapperDir, "omp-without-command-list.sh");
writeFileSync(wrapper, `#!/bin/sh\nexec bun "${PROXY}" "${REAL_OMP}" "$@"\n`);
chmodSync(wrapper, 0o755);
realTest.use({ ompBinary: wrapper });

const HELD =
  "/compact wasn't sent because omp's command list could not be read. omp could not list its commands.";
const TYPED = "hello there";

function composerError(page: Page): Locator {
  return page.locator('[data-composer-error="true"]');
}

/** A websocket frame as an object, or undefined for a frame that is not JSON. */
function frameOf(message: string | Buffer): Record<string, unknown> | undefined {
  try {
    return JSON.parse(String(message)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** An answer the server sent that the page has not received yet. */
interface WaitingAnswer {
  readonly ws: WebSocketRoute;
  readonly message: string | Buffer;
}

/** One rule: the answers to `method` on `port` are held back while `holding` is true. */
interface AnswerRule {
  readonly port: string;
  readonly method: string;
  readonly requestIds: Set<string>;
  readonly waiting: WaitingAnswer[];
  holding: boolean;
}

/** The test's handle on one rule: how many answers wait, and the release that sends them. */
interface HeldAnswers {
  readonly waiting: () => number;
  readonly release: () => void;
}

/** Holds answers on the one connection the app uses. Rules are added before the actions they hold. */
class AnswerHolds {
  private readonly rules: AnswerRule[] = [];

  /** Holds the answers to `method` on `port`, from now on, until released. */
  hold(port: string, method: string): HeldAnswers {
    const rule: AnswerRule = {
      port,
      method,
      requestIds: new Set<string>(),
      waiting: [],
      holding: true,
    };
    this.rules.push(rule);
    return {
      waiting: () => rule.waiting.length,
      release: () => {
        rule.holding = false;
        for (const answer of rule.waiting.splice(0)) answer.ws.send(answer.message);
      },
    };
  }

  /** Routes the page's websocket through the rules. */
  async install(page: Page): Promise<void> {
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        const frame = frameOf(message);
        if (frame?.type === "call") {
          for (const rule of this.rules) {
            if (rule.holding && frame.port === rule.port && frame.method === rule.method) {
              rule.requestIds.add(String(frame.id));
            }
          }
        }
        server.send(message);
      });
      server.onMessage((message) => {
        const frame = frameOf(message);
        if (frame?.type === "result") {
          const id = String(frame.id);
          const rule = this.rules.find(
            (candidate) => candidate.holding && candidate.requestIds.has(id),
          );
          if (rule !== undefined) {
            rule.waiting.push({ ws, message });
            return;
          }
        }
        ws.send(message);
      });
    });
  }
}

/**
 * The issue's steps: a held command, the chat's move held at the store, the next message typed while the move waits,
 * then the move completes. The composer must keep the typed message, and Enter must send it.
 */
async function heldThenTyped(
  page: Page,
  holds: AnswerHolds,
  onKept: () => Promise<void>,
): Promise<Locator> {
  // The chat's history waits on this answer, so the new chat is still loading while the held send is made.
  const opening = holds.hold("A0.rpcSession", "openQuestions");
  const composer = await startChat(page);

  await composer.fill("/compact");
  await composer.press("Enter");
  await expect(composerError(page)).toHaveText(HELD, { timeout: 60_000 });
  await expect(composer).toHaveValue("/compact");

  // The chat finishes loading, so its draft moves to the folder's new-chat draft. The move's store write waits here.
  const moving = holds.hold("A1.draftStore", "clear");
  opening.release();
  await expect.poll(() => moving.waiting(), { timeout: 60_000 }).toBeGreaterThan(0);

  // The person types the next message while the move waits.
  await composer.fill(TYPED);
  moving.release();

  // The message the person typed is what the composer keeps, not the held command.
  await expect(composer).toHaveValue(TYPED, { timeout: 30_000 });
  await waitForFiniteAnimations(page);
  await onKept();
  return composer;
}

realTest(
  "#1477: text typed while a new chat's draft moves is kept, and the held command does not come back over it (light, 390 px)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const holds = new AnswerHolds();
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light"));
        await holds.install(target);
      },
    });
    const composer = await heldThenTyped(page, holds, async () => {
      await page.screenshot({ path: join(screenshots, "fix-1477-typed-after-move-light.png") });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(composer).toHaveValue(TYPED);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1477-typed-after-move-narrow.png") });

    await composer.press("Enter");
    await expect(page.getByText("pong").first()).toBeVisible({ timeout: 60_000 });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1477: the same flow in dark theme keeps the typed message in the composer",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const holds = new AnswerHolds();
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark"));
        await holds.install(target);
      },
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    const composer = await heldThenTyped(page, holds, async () => {
      await page.screenshot({ path: join(screenshots, "fix-1477-typed-after-move-dark.png") });
    });
    await composer.press("Enter");
    await expect(page.getByText("pong").first()).toBeVisible({ timeout: 60_000 });
    expect(realApp.problems).toEqual([]);
  },
);
