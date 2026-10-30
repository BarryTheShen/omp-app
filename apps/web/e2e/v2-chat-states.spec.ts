import { expect, realTest } from "./real-omp";

/** The new UI's chat states (`apps/ui`, under `/v2/`) on real omp: a new chat's welcome, and a link that expired. */
realTest.describe("new UI chat states", () => {
  realTest.setTimeout(240_000);

  realTest(
    "a new chat greets with its folder and the box's keys until the first message",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await page
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: "New chat" })
        .click();
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });

      const welcome = page.getByText("What are we working on?");
      await expect(welcome).toBeVisible();
      // The welcome names the folder by the end of its path.
      const tail = `…/${realApp.folder.split("/").slice(-2).join("/")}`;
      await expect(page.getByText(tail, { exact: true })).toBeVisible();

      await box.fill("hello");
      await box.press("Enter");
      await expect(page.getByRole("region", { name: "Transcript" }).getByText("pong")).toBeVisible({
        timeout: 60_000,
      });
      await expect(welcome).toHaveCount(0);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "says the link expired when the app's server starts again with a new one",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await expect(page.getByRole("navigation", { name: "Chats" })).toBeVisible({
        timeout: 60_000,
      });
      // The expired link's refusal is reported by the page; it is the case under test.
      realApp.allowProblem(/WebSocket|401|403|expired/i);

      // The harness's restart prints a new link with a new token, so the page's link expires.
      await realApp.restartServer();
      await expect(
        page.getByRole("alert").filter({ hasText: "This link has expired." }),
      ).toBeVisible({
        timeout: 90_000,
      });
    },
  );
});
