import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

realTest.setTimeout(300_000);
// omp-app comes back on the same port, so the same tab is still on the same origin after the restart.
realTest.use({ serverPort: Number(process.env.E2E_PORT ?? 4173) + 10 });

const DRAFT = "draft that must survive the restart";

function composer(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message input" });
}

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

/** The files the app keeps saved thread drafts in, one per chat. */
function savedThreadDrafts(appDataDir: string): string[] {
  const dir = join(appDataDir, "drafts", "threads");
  return existsSync(dir) ? readdirSync(dir) : [];
}

realTest(
  "a draft typed right before the app restarts is in the composer after the new link opens",
  async ({ realApp }) => {
    // While omp-app is stopped the old tab cannot reach it: those connection errors are expected.
    realApp.allowProblem(/WebSocket connection to .* failed/);
    const app = await realApp.open();
    const first = await startChat(app);
    await sendPrompt(first, "chat with a prompt");
    await expect(transcript(app).getByText("pong", { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await composer(app).fill(DRAFT);
    await expect(composer(app)).toHaveValue(DRAFT);

    // Stop omp-app and start it again on the same port. The new launch link has a new token, so the old one expires.
    const link = await realApp.restartServer();
    await expect(app.getByRole("heading", { name: "This launch link has expired" })).toBeVisible({
      timeout: 90_000,
    });

    // Opening the new link in the same tab loads the app again from that address.
    await app.goto("about:blank");
    await app.goto(link);
    await expect(transcript(app).getByText("pong", { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await expect(composer(app)).toHaveValue(DRAFT, { timeout: 30_000 });

    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-837-restart-draft-light.png"),
      fullPage: true,
    });

    await app.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(app.locator("html")).toHaveClass(/dark/);
    await expect(app.locator("body")).toHaveCSS("background-color", /^(rgb|oklch)/);
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-837-restart-draft-dark.png"),
      fullPage: true,
    });
    await app.evaluate(() => document.documentElement.classList.remove("dark"));

    await app.setViewportSize({ width: 390, height: 844 });
    await expect(composer(app)).toHaveValue(DRAFT);
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-837-restart-draft-narrow.png"),
      fullPage: true,
    });
  },
);

realTest(
  "a draft the app had already saved is in the composer after the app restarts, once",
  async ({ realApp }) => {
    realApp.allowProblem(/WebSocket connection to .* failed/);
    const app = await realApp.open();
    const first = await startChat(app);
    await sendPrompt(first, "chat with a prompt");
    await expect(transcript(app).getByText("pong", { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await composer(app).fill(DRAFT);
    // The app saves a draft about ten seconds after the last change. Wait for the saved file, not a fixed delay.
    await expect
      .poll(() => savedThreadDrafts(realApp.appDataDir).length, { timeout: 60_000 })
      .toBe(1);

    const link = await realApp.restartServer();
    await expect(app.getByRole("heading", { name: "This launch link has expired" })).toBeVisible({
      timeout: 90_000,
    });
    await app.goto("about:blank");
    await app.goto(link);
    await expect(transcript(app).getByText("pong", { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    // Once, not twice: the text kept in this tab is the saved text, so it is not added again.
    await expect(composer(app)).toHaveValue(DRAFT, { timeout: 30_000 });
  },
);
