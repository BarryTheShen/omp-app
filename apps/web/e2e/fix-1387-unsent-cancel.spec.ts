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
 * Opens a chat whose question the first answer call after `refuseNext` is refused on the wire, as omp would refuse it
 * (the same way the #1318 spec refuses a Submit). Returns the page and the count of refusals.
 */
async function openRefusingFirstAnswer(
  realApp: RealApp,
): Promise<{ page: Page; refused: () => number; refuseNext: () => void }> {
  let armed = false;
  let refusals = 0;
  const page = await realApp.open({
    beforeLoad: async (target) => {
      await target.routeWebSocket(/\/ws\?/, (socket) => {
        const server = socket.connectToServer();
        server.onMessage((message) => socket.send(message));
        socket.onMessage((message) => {
          const id = answerCallId(message);
          if (armed && id !== undefined) {
            armed = false;
            refusals += 1;
            socket.send(
              JSON.stringify({
                type: "result",
                id,
                ok: false,
                error: {
                  code: "unavailable",
                  message: "omp did not accept the answer.",
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
    refused: () => refusals,
    refuseNext: () => {
      armed = true;
    },
  };
}

/**
 * Issue 1387 on real omp. A Cancel that omp does not receive keeps the question open and says the answer was not sent,
 * the same as a refused answer (issue 1318). No toast says a message could not be shown, and the next Cancel reaches omp
 * and closes the question.
 */
realTest(
  "a Cancel omp refuses keeps the question open and says the answer was not sent",
  async ({ realApp }) => {
    const { page, refused, refuseNext } = await openRefusingFirstAnswer(realApp);
    const composer = await startChat(page);
    await sendPrompt(composer, PROMPT);
    const question = page.getByRole("dialog", { name: QUESTION });
    await expect(question).toBeVisible({ timeout: 45_000 });

    refuseNext();
    await question.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(refused, { timeout: 30_000 }).toBe(1);
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
    expect(refused()).toBe(1);
    await expect(page.getByText(ROUTING_TOAST)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);

/**
 * Issue 1387 on real omp: an Escape that omp does not receive is a Cancel, so the question is shown again, saying the
 * answer was not sent.
 */
realTest(
  "an Escape omp refuses shows the question again, saying the answer was not sent",
  async ({ realApp }) => {
    const { page, refused, refuseNext } = await openRefusingFirstAnswer(realApp);
    const composer = await startChat(page);
    await sendPrompt(composer, PROMPT);
    const question = page.getByRole("dialog", { name: QUESTION });
    await expect(question).toBeVisible({ timeout: 45_000 });

    refuseNext();
    await page.keyboard.press("Escape");
    await expect.poll(refused, { timeout: 30_000 }).toBe(1);
    await expect(page.getByRole("dialog")).toHaveCount(1, { timeout: 30_000 });
    await expect(question.getByRole("alert")).toHaveText(NOT_SENT);
    await expect(page.getByText(ROUTING_TOAST)).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "fix-1387-escape-light.png") });

    await question.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(question).toBeHidden({ timeout: 30_000 });
    expect(refused()).toBe(1);
    expect(realApp.problems).toEqual([]);
  },
);
