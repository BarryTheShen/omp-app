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

/** The id of a client call that answers a question omp asked, or undefined for any other frame. */
function answerCallId(message: string | Buffer): string | undefined {
  const text = typeof message === "string" ? message : message.toString("utf8");
  if (!text.includes('"method":"answerExtensionUi"')) return undefined;
  return /"id":"([^"]+)"/.exec(text)?.[1];
}

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

/**
 * Issue #1318. When the app cannot send an answer, the question stays open with the choice made and says the answer
 * was not sent; sending it again answers omp and closes the question.
 */
realTest(
  "an answer that cannot be sent keeps the question open with the choice, and retrying answers omp",
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
              // Mirrors the server's AppFailure when its omp RPC transport closes (rpc-session.ts:281-284).
              socket.send(
                JSON.stringify({
                  type: "result",
                  id,
                  ok: false,
                  error: {
                    code: "omp_exited",
                    message: "The omp RPC transport closed",
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
    // The question stays open with the choice, and says the send failed. No toast says a message could not be shown.
    await expect(question.getByRole("alert")).toHaveText(NOT_SENT);
    await expect(question.getByText("SQLite", { exact: true })).toBeVisible();
    await expect(page.getByText("omp update unavailable")).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "fix-1318-failed-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "fix-1318-failed-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "fix-1318-failed-390.png") });
    await page.setViewportSize({ width: 1280, height: 800 });

    // Sending the same answer again goes through: the question closes once omp has the answer.
    await question.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(question).toBeHidden({ timeout: 30_000 });
    expect(failures).toBe(1);
    expect(realApp.problems).toEqual([]);
  },
);
