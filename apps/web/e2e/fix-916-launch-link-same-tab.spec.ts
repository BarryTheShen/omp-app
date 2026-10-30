import { expect, oldUiLink, realTest, sendPrompt, startChat } from "./real-omp";

/**
 * Issue 916. After omp-app restarts, the new launch link typed into the tab that is already open
 * (only its fragment differs from the page's address) did nothing: the tab stayed on "This launch
 * link has expired" until a reload. restart-draft.spec.ts avoids the case by going to about:blank
 * first; this spec does not.
 */
// omp-app comes back on the same port, so the open tab is still on the same origin after the restart.
realTest.use({ serverPort: Number(process.env.E2E_PORT ?? 4173) + 5 });
realTest.setTimeout(300_000);

realTest(
  "a launch link typed into the open tab after a restart opens the app with its chat",
  async ({ realApp }) => {
    // While omp-app is stopped the open tab cannot reach it: those connection errors are expected.
    realApp.allowProblem(/WebSocket connection to .* failed/);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "chat with a prompt");
    const transcript = page.getByRole("region", { name: "Conversation transcript" });
    await expect(transcript.getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });

    // Stop omp-app and start it again on the same port: the new link has a new token, so the old one expires.
    const link = await realApp.restartServer();
    await expect(page.getByRole("heading", { name: "This launch link has expired" })).toBeVisible({
      timeout: 90_000,
    });

    // The new link typed into the same tab, as a person does: only the fragment changes.
    await page.goto(oldUiLink(link));
    await expect(page.getByRole("heading", { name: "This launch link has expired" })).toHaveCount(
      0,
      { timeout: 30_000 },
    );
    await expect(transcript.getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });
  },
);
