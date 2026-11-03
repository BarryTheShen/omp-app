import { expect, realTest, startNewChat } from "./real-omp";

/** The new UI (`apps/ui`, served under `/v2/`): a saved chat, a streamed reply and Stop, on real omp. */
realTest.describe("new UI core", () => {
  realTest.use({ seedSessions: 2, seedLongTurn: 20 });

  realTest(
    "opens a saved chat at its end, streams a new chat's reply, and Esc stops a reply",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      const page = await realApp.open({ path: "/" });
      const chats = page.getByRole("navigation", { name: "Chats" });
      const transcript = page.getByRole("region", { name: "Transcript" });

      await chats.getByRole("button", { name: "Run the long job" }).click();
      // The list starts at the latest entry: the last answer is on screen without scrolling.
      await expect(transcript.getByText("All 20 steps are done.")).toBeInViewport({
        timeout: 60_000,
      });

      await startNewChat(page);
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill("stream_code please");
      await box.press("Enter");
      await expect(transcript.getByText("stream_code please")).toBeVisible({ timeout: 30_000 });
      await expect(transcript.getByText("export const answer = sum([1, 2, 3]);")).toBeInViewport({
        timeout: 60_000,
      });

      await box.fill("stream_steady");
      await box.press("Enter");
      await expect(transcript.getByText(/Steady line 3:/)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
      await box.press("Escape");
      await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });
      await expect(transcript.getByText(/Steady line 230:/)).toHaveCount(0);

      expect(realApp.problems).toEqual([]);
    },
  );
});
