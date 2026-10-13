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

/**
 * A first message sent right after New chat stays in that chat. The message is a `!` line, so its output is the proof:
 * it shows in the new chat, the composer is cleared, and no error closes the chat. The line is sent as soon as the
 * composer is there, the way a person types. Light, dark, and a 390 px phone.
 */

const OUTPUT = /No such file or directory/;
const SUPERSEDED = "A newer history request superseded this one";
const CLOSED = "Open a session to start composing.";
const DESKTOP = { width: 1280, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;

/** Opens the app in one theme, applied before the first paint. */
function themed(name: "light" | "dark") {
  return {
    beforeLoad: (target: Page) =>
      target.addInitScript(
        (value: string) => window.localStorage.setItem("omp-app.theme", value),
        name,
      ),
  };
}

/** Clicks New chat, sends a `!` line at once, and waits until the line's output shows in that chat. */
async function sendFirstLine(page: Page): Promise<void> {
  const composer = await startChat(page);
  await sendPrompt(composer, "!ls /no-such-dir-first-message");
  await expect(page.getByText(OUTPUT).first(), "the output shows in the new chat").toBeVisible({
    timeout: 60_000,
  });
  await expect(composer, "the composer is cleared").toHaveValue("");
  await expect(page.getByText(SUPERSEDED), "no error closes the chat").toHaveCount(0);
  await expect(page.getByText(CLOSED), "the chat is still open").toHaveCount(0);
}

realTest(
  "a first `!` line sent right after New chat stays in that chat: light",
  async ({ realApp }) => {
    const page = await realApp.open(themed("light"));
    await page.setViewportSize(DESKTOP);
    await sendFirstLine(page);
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await page
      .getByRole("region", { name: "Conversation transcript" })
      .screenshot({ path: join(screenshots, "fix-1485-first-line-light.png") });

    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a first `!` line sent right after New chat stays in that chat: dark",
  async ({ realApp }) => {
    const page = await realApp.open(themed("dark"));
    await page.setViewportSize(DESKTOP);
    await sendFirstLine(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await page
      .getByRole("region", { name: "Conversation transcript" })
      .screenshot({ path: join(screenshots, "fix-1485-first-line-dark.png") });

    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a first `!` line sent right after New chat stays in that chat: 390 px phone",
  async ({ realApp }) => {
    const page = await realApp.open(themed("light"));
    // The session list is hidden at 390 px, so the chat starts at the desktop width and the window narrows after.
    await page.setViewportSize(DESKTOP);
    await sendFirstLine(page);
    await page.setViewportSize(PHONE);
    await expect(page.getByText(OUTPUT).first(), "the output still shows at 390 px").toBeVisible();
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows, "no sideways scroll at 390 px").toBe(false);
    await waitForFiniteAnimations(page);
    await page
      .getByRole("region", { name: "Conversation transcript" })
      .screenshot({ path: join(screenshots, "fix-1485-first-line-phone.png") });

    expect(realApp.problems).toEqual([]);
  },
);
