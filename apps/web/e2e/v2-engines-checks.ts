import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The app in each browser engine people use (the platforms plan's P1): it opens, a new chat answers on the fake
 * model, and the chat is there again after a reload. Chromium (Chrome and Edge), WebKit (Safari and the Linux desktop
 * window) and Firefox, each from its own spec file.
 */

export type Engine = "chromium" | "webkit" | "firefox";

const NAMES: Record<Engine, string> = {
  chromium: "Chromium",
  webkit: "WebKit",
  firefox: "Firefox",
};

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });

export function defineEngineChecks(engine: Engine): void {
  realTest.describe(`the app in ${NAMES[engine]}`, () => {
    realTest.setTimeout(240_000);

    realTest(
      "opens, a new chat answers, and the chat is there again after a reload",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
        await startNewChat(page);
        await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
        await box(page).fill("hello");
        await box(page).press("Enter");
        await expect(transcript(page).getByText("pong", { exact: true })).toBeVisible({
          timeout: 90_000,
        });

        await page.reload();
        await expect(transcript(page).getByText("pong", { exact: true })).toBeVisible({
          timeout: 60_000,
        });
        await expect(box(page)).toBeEnabled();
      },
    );
  });
}
