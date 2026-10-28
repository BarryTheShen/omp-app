import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  type RealApp,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

realTest.setTimeout(300_000);

const PROMPT = "Please ask_user which database to use.";
/** The ask dialog is named by its heading, "Answer questions" (#850). */
const QUESTION = /^Answer questions$/;
const NOT_SENT = "Sending your answer failed. Try again.";
/** The toast the app shows when a message cannot be routed (the failure issue 1387 removes for a Cancel or Escape). */
const ROUTING_TOAST = "omp update unavailable";

/** The id of a client call that answers a question omp asked (the session port's `answer`), or undefined for any other frame. */
function answerCallId(message: string | Buffer): string | undefined {
  const text = typeof message === "string" ? message : message.toString("utf8");
  let frame: { type?: unknown; id?: unknown; port?: unknown; method?: unknown };
  try {
    frame = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (frame.type !== "call" || frame.port !== "A0.chatSession" || frame.method !== "answer") {
    return undefined;
  }
  return typeof frame.id === "string" ? frame.id : undefined;
}

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

/**
 * Opens a chat where the first answer call after `failNext` fails at the app connection, as in the #1318 spec.
 * Returns the page and the count of failed sends.
 */
async function openFailingFirstAnswer(
  realApp: RealApp,
): Promise<{ page: Page; failed: () => number; failNext: () => void }> {
  let armed = false;
  let failures = 0;
  const page = await realApp.open({
    beforeLoad: async (target) => {
      await target.routeWebSocket(/\/ws\?/, (socket) => {
        const server = socket.connectToServer();
        server.onMessage((message) => socket.send(message));
        socket.onMessage((message) => {
          const id = answerCallId(message);
          if (armed && id !== undefined) {
            armed = false;
            failures += 1;
            // Mirrors the server's AppFailure when the chat host closes before it answers (`packages/server/src/ports/A0/chat-session.ts`).
            socket.send(
              JSON.stringify({
                type: "result",
                id,
                ok: false,
                error: {
                  code: "omp_exited",
                  message: "omp stopped before it answered. Try again.",
                  retryable: true,
                },
              }),
            );
            return;
          }
          server.send(message);
        });
      });
    },
  });
  return {
    page,
    failed: () => failures,
    failNext: () => {
      armed = true;
    },
  };
}

/**
 * Issue 1387 on real omp. A Cancel that fails to reach omp keeps the question open and says the answer was not sent.
 * No toast says a message could not be shown, and the next Cancel reaches omp and closes the question.
 */
realTest(
  "a Cancel that fails to reach omp keeps the question open and says the answer was not sent",
  async ({ realApp }) => {
    const { page, failed, failNext } = await openFailingFirstAnswer(realApp);
    const composer = await startChat(page);
    await sendPrompt(composer, PROMPT);
    const question = page.getByRole("dialog", { name: QUESTION });
    await expect(question).toBeVisible({ timeout: 45_000 });

    failNext();
    await question.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(failed, { timeout: 30_000 }).toBe(1);
    // The question is shown again once the closed one has left: exactly one question on screen, saying the send failed.
    await expect(page.getByRole("dialog")).toHaveCount(1, { timeout: 30_000 });
    await expect(question.getByRole("alert")).toHaveText(NOT_SENT);
    await expect(page.getByText(ROUTING_TOAST)).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "fix-1387-cancel-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "fix-1387-cancel-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "fix-1387-cancel-390.png") });
    await page.setViewportSize({ width: 1280, height: 800 });

    // The next Cancel reaches omp, and the question closes with no toast.
    await question.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(question).toBeHidden({ timeout: 30_000 });
    expect(failed()).toBe(1);
    await expect(page.getByText(ROUTING_TOAST)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);

/**
 * Issue 1387 on real omp: an Escape whose answer fails to reach omp is a Cancel, so the question is shown again,
 * saying the answer was not sent.
 */
realTest(
  "an Escape whose answer fails to reach omp shows the question again, saying the answer was not sent",
  async ({ realApp }) => {
    const { page, failed, failNext } = await openFailingFirstAnswer(realApp);
    const composer = await startChat(page);
    await sendPrompt(composer, PROMPT);
    const question = page.getByRole("dialog", { name: QUESTION });
    await expect(question).toBeVisible({ timeout: 45_000 });

    failNext();
    await page.keyboard.press("Escape");
    await expect.poll(failed, { timeout: 30_000 }).toBe(1);
    await expect(page.getByRole("dialog")).toHaveCount(1, { timeout: 30_000 });
    await expect(question.getByRole("alert")).toHaveText(NOT_SENT);
    await expect(page.getByText(ROUTING_TOAST)).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "fix-1387-escape-light.png") });

    await question.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(question).toBeHidden({ timeout: 30_000 });
    expect(failed()).toBe(1);
    expect(realApp.problems).toEqual([]);
  },
);
