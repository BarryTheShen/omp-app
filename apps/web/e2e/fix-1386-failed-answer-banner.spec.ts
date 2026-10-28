import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
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
/** The thread's error banner (U1), which says "The conversation could not continue." for a failure of the chat. */
const BANNER = '[data-slot="u1-thread-error"]';

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
 * Issue 1386 on real omp. When the app cannot send an answer to a question (issue 1318), the question stays open and
 * says the answer was not sent. That failure is not written to the thread's banner, and retrying the answer closes
 * the question with no banner left behind.
 */
realTest(
  "a failed answer shows only in the question, and no banner is left after retry",
  async ({ realApp }) => {
    let failNext = false;
    let failures = 0;
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.routeWebSocket(/\/ws\?/, (socket) => {
          const server = socket.connectToServer();
          server.onMessage((message) => socket.send(message));
          socket.onMessage((message) => {
            const id = answerCallId(message);
            if (failNext && id !== undefined) {
              failNext = false;
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

    const composer = await startChat(page);
    await sendPrompt(composer, PROMPT);
    const question = page.getByRole("dialog", { name: QUESTION });
    await expect(question).toBeVisible({ timeout: 45_000 });
    await question.getByRole("radio", { name: /^SQLite/ }).click();
    await question.getByRole("button", { name: "Review", exact: true }).click();

    failNext = true;
    await question.getByRole("button", { name: "Submit", exact: true }).click();
    await expect.poll(() => failures, { timeout: 30_000 }).toBe(1);
    // The question says sending failed; the thread shows no banner. Read the banner after the dialog has rendered.
    await expect(question.getByRole("alert")).toHaveText(NOT_SENT);
    await expect(page.locator(BANNER)).toHaveCount(0);
    await expect(page.getByText("The conversation could not continue.")).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "fix-1386-failed-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "fix-1386-failed-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "fix-1386-failed-390.png") });
    await page.setViewportSize({ width: 1280, height: 800 });

    // Sending the same answer again goes through: the question closes, and the thread shows no banner.
    await question.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(question).toBeHidden({ timeout: 30_000 });
    expect(failures).toBe(1);
    await expect(page.locator(BANNER)).toHaveCount(0);
    await expect(page.getByText("The conversation could not continue.")).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "fix-1386-answered-light.png") });
    expect(realApp.problems).toEqual([]);
  },
);
