import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

realTest.setTimeout(300_000);

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

/**
 * Holds every saved-draft read the app sends to the server until `release()`, so a new chat's draft is still
 * loading while the person types. Holding the frame in the page (not the server) keeps the read in flight.
 */
function holdDraftReads(): {
  readonly beforeLoad: (page: Page) => Promise<void>;
  readonly release: () => void;
} {
  const forwards: Array<() => void> = [];
  let holding = true;
  return {
    beforeLoad: async (page) => {
      await page.routeWebSocket(
        () => true,
        (webSocket) => {
          const server = webSocket.connectToServer();
          webSocket.onMessage((message) => {
            let isDraftRead = false;
            try {
              const frame = JSON.parse(String(message)) as Record<string, unknown>;
              isDraftRead =
                frame.type === "call" && frame.port === "A1.draftStore" && frame.method === "get";
            } catch {
              // Non-JSON frames are forwarded unchanged.
            }
            if (holding && isDraftRead) {
              forwards.push(() => server.send(message));
              return;
            }
            server.send(message);
          });
        },
      );
    },
    release: () => {
      holding = false;
      for (const forward of forwards.splice(0)) forward();
    },
  };
}

realTest(
  "text typed while a new chat's draft is still loading is still there once it loads",
  async ({ realApp }) => {
    const held = holdDraftReads();
    const app = await realApp.open({ beforeLoad: held.beforeLoad });
    const input = await startChat(app);
    await input.fill("typed during load");
    await expect(input).toHaveValue("typed during load");

    held.release();
    // The saved draft has loaded now. The text typed before it arrived must still be in the composer.
    await expect(input).toHaveValue("typed during load", { timeout: 30_000 });
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-900-typed-before-load-light.png"),
      fullPage: true,
    });

    await app.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(app.locator("html")).toHaveClass(/dark/);
    await expect(app.locator("body")).toHaveCSS("background-color", /^(rgb|oklch)/);
    await expect(input).toHaveValue("typed during load");
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-900-typed-before-load-dark.png"),
      fullPage: true,
    });
    await app.evaluate(() => document.documentElement.classList.remove("dark"));

    await app.setViewportSize({ width: 390, height: 844 });
    await expect(input).toHaveValue("typed during load");
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-900-typed-before-load-narrow.png"),
      fullPage: true,
    });

    // The text that stayed is what gets sent, and the reply comes back.
    await input.press("Enter");
    await expect(transcript(app).getByText("typed during load", { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await expect(transcript(app).getByText("pong", { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await expect(input).toHaveValue("");
  },
);

realTest("a prompt sent while a new chat's draft is still loading is sent", async ({ realApp }) => {
  const held = holdDraftReads();
  const app = await realApp.open({ beforeLoad: held.beforeLoad });
  const input = await startChat(app);
  await input.fill("sent during load");
  await input.press("Enter");

  held.release();
  await expect(transcript(app).getByText("sent during load", { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  await expect(transcript(app).getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(input).toHaveValue("");
});
