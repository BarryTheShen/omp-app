import { expect, realTest } from "./real-omp";

/**
 * D2 in the browser (`OMP_APP_DETACHED_HOSTS=1`): a reply under way when the server restarts keeps going in its chat's
 * host, and the chat, open again after the restart, shows the whole reply, once.
 */
realTest.use({ serverEnv: { OMP_APP_DETACHED_HOSTS: "1" } });

realTest.describe("chats through a server restart", () => {
  realTest.setTimeout(300_000);

  realTest(
    "a reply under way when the server restarts is shown whole, once",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await page
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: "New chat" })
        .click();
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill("stream_steady");
      await box.press("Enter");
      const transcript = page.getByRole("region", { name: "Transcript" });
      await expect(transcript).toContainText("Steady line 10:", { timeout: 60_000 });

      // The server restarts while the reply streams; the page comes back with its tabs and panes.
      const context = page.context();
      await page.close();
      await realApp.restartServer();
      const again = await realApp.open({ path: "/", context });
      const reopened = again.getByRole("region", { name: "Transcript" });

      // The reply goes on to its end, and shows once.
      await expect(reopened).toContainText("Steady line 239:", { timeout: 180_000 });
      await expect(reopened.getByText("Steady line 239:")).toHaveCount(1);
      await expect(reopened.getByText("Steady line 0:")).toHaveCount(1);
      expect(realApp.problems).toEqual([]);
    },
  );
});
