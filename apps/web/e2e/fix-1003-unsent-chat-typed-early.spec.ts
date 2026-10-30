import { expect, oldUiLink, realTest, startChat } from "./real-omp";

realTest.setTimeout(300_000);
// omp-app comes back on the same port, so the old tab reaches the new server with its old token and shows the expired page.
realTest.use({ serverPort: Number(process.env.E2E_PORT ?? 4173) + 10 });

const DRAFT = "typed right after New chat";

/**
 * Issue #1003. Text typed in a new chat in its first second or two, while the chat's history is still loading, is lost
 * when the server restarts and the new link opens. The text must come back in the composer. The restart follows the
 * typing by two seconds, the pause the live tester's probe used. In this harness the loss does not reproduce on main,
 * so this spec is a regression check; the unit tests carry the red proof.
 */
realTest(
  "text typed right after New chat, before its history loads, is in the composer after the server restarts",
  async ({ realApp }) => {
    // While omp-app is stopped the old tab cannot reach it: those connection errors are expected.
    realApp.allowProblem(/WebSocket connection to .* failed/);
    const app = await realApp.open();
    const composer = await startChat(app);
    // No wait for the loaded chat: the text is typed while its history is still loading.
    await composer.fill(DRAFT);
    await expect(composer).toHaveValue(DRAFT);
    await app.waitForTimeout(2_000);

    // Stop omp-app and start it again on the same port. The new launch link has a new token, so the old one expires.
    const link = await realApp.restartServer();
    await expect(app.getByRole("heading", { name: "This launch link has expired" })).toBeVisible({
      timeout: 90_000,
    });

    // Opening the new link in the same tab loads the app again from that address.
    await app.goto("about:blank");
    await app.goto(oldUiLink(link));
    await expect(composer).toHaveValue(DRAFT, { timeout: 60_000 });
    // The restored chat has no message, so the session list still has none.
    await expect(app.getByText("No sessions in this folder")).toBeVisible({ timeout: 30_000 });
  },
);
