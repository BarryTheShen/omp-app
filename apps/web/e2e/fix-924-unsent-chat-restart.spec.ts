import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

realTest.setTimeout(300_000);
// omp-app comes back at the same address: a port of 0 is picked at the first start and kept across the restart, so the old tab
// reaches the new server with its old token and shows the expired page. A fixed port collided between parallel workers.
realTest.use({ serverPort: 0 });

const DRAFT = "draft in an unsent chat";

/**
 * Issue #924. Text typed in a new chat that has no message is gone after the server restarts and the new link opens.
 * The tab must come back with that text in the composer, as #837 does for a chat with messages.
 */
realTest(
  "text typed in an unsent new chat is in the composer after the server restarts and the new link opens",
  async ({ realApp }) => {
    // While omp-app is stopped the old tab cannot reach it: those connection errors are expected.
    realApp.allowProblem(/WebSocket connection to .* failed/);
    const app = await realApp.open();
    const composer = await startChat(app);
    // The chat has loaded (the thread shows its empty state). Text typed while its history is still loading is kept under
    // the chat's own id until the draft moves to the folder's new-chat draft, which a restart in that window loses (#1003).
    await expect(app.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await composer.fill(DRAFT);
    await expect(composer).toHaveValue(DRAFT);

    // Stop omp-app and start it again on the same port. The new launch link has a new token, so the old one expires.
    const link = await realApp.restartServer();
    await expect(app.getByRole("heading", { name: "This launch link has expired" })).toBeVisible({
      timeout: 90_000,
    });

    // Opening the new link in the same tab loads the app again from that address.
    await app.goto("about:blank");
    await app.goto(link);
    await expect(composer).toHaveValue(DRAFT, { timeout: 60_000 });
    // The restored chat has no message, so the session list still has none.
    await expect(app.getByText("No sessions in this folder")).toBeVisible({ timeout: 30_000 });

    await waitForFiniteAnimations(app);
    await mkdir(screenshots, { recursive: true });
    await app.screenshot({
      path: join(screenshots, "fix-924-unsent-chat-after-restart.png"),
      fullPage: true,
    });

    // The same restored composer in dark mode, then at a phone width. Styles must have loaded before each capture.
    await app.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(app.locator("html")).toHaveClass(/dark/);
    await expect(app.locator("body")).toHaveCSS("background-color", /^(rgb|oklch)/);
    await expect(composer).toHaveValue(DRAFT);
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-924-unsent-chat-after-restart-dark.png"),
      fullPage: true,
    });
    await app.evaluate(() => document.documentElement.classList.remove("dark"));

    await app.setViewportSize({ width: 390, height: 844 });
    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue(DRAFT);
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-924-unsent-chat-after-restart-narrow.png"),
      fullPage: true,
    });
  },
);
