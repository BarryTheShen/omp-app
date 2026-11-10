import { expect, realTest, startNewChat } from "./real-omp";

/** The new UI's chat states (`apps/ui`, under `/v2/`) on real omp: a new chat's welcome, and a link that expired. */
realTest.describe("new UI chat states", () => {
  realTest.setTimeout(240_000);

  realTest(
    "a new chat greets with its folder and the box's keys until the first message",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
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
      // The expired link's refusal is reported by the page; it is the case under test. While the server is down for the
      // restart, the page's lazy loads (a font face, the icon) are refused as well.
      realApp.allowProblem(/WebSocket|401|403|expired|ERR_CONNECTION_REFUSED/i);

      // The harness's restart prints a new link with a new token, so the page's link expires.
      const link = await realApp.restartServer();
      const expired = page.getByRole("alert").filter({ hasText: "This link has expired." });
      await expect(expired).toBeVisible({ timeout: 90_000 });

      // The new link typed into the same tab changes only the address's fragment: the app works again.
      await page.goto(link);
      await expect(expired).toHaveCount(0, { timeout: 60_000 });
      await startNewChat(page);
      await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
        "placeholder",
        "Message omp",
        { timeout: 120_000 },
      );

      // What the restart prints is allowed above; the harness fails the test at its end on anything else.
    },
  );

  realTest(
    "a reply under way when the server restarts with the chat's omp ending: back on the page, it is not shown as going on (#9)",
    async ({ realApp }) => {
      // A paired device, as a phone is: its pairing outlasts the restart, so the same page comes back on its own and
      // picks the chat up where it was (a page on the launch link would have to be given the new link).
      const owner = await realApp.open({ path: "/" });
      await owner.getByRole("button", { name: "Settings", exact: true }).click();
      const devices = owner.getByRole("region", { name: "Devices" });
      await devices.getByRole("button", { name: "Pair a new device" }).click();
      const shown = devices
        .getByRole("region", { name: "One-time code" })
        .getByText(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      await expect(shown).toBeVisible();
      const code = ((await shown.textContent()) ?? "").replace("-", "");
      const page = await realApp.open({ path: "/", hash: `#pair=${code}` });
      await startNewChat(page);
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      const transcript = page.getByRole("region", { name: "Transcript" });
      // A chat omp has written to its file (a new chat's file is written with its first reply).
      await box.fill("hello");
      await box.press("Enter");
      await expect(transcript.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
      await box.fill("stream_steady");
      await box.press("Enter");
      await expect(transcript).toContainText("Steady line 10:", { timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
      // The restart's refusals: the owner page's link expires, and both pages miss the server while it is down.
      realApp.allowProblem(/WebSocket|401|403|expired|ERR_CONNECTION_REFUSED/i);

      // The harness's chats end with its server (no detached hosts): the reply ends with the restart.
      await realApp.restartServer();

      // Back on the paired page, the chat opens again from its file: nothing is writing, and it takes the next message.
      await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 60_000 });
      await expect(page.getByRole("status").filter({ hasText: /^Writing/ })).toHaveCount(0);
      await expect(transcript.getByText("stream_steady", { exact: true })).toBeVisible();
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill("hello");
      await box.press("Enter");
      await expect(transcript.getByText("pong", { exact: true })).toHaveCount(2, {
        timeout: 60_000,
      });
    },
  );

  realTest(
    "says a link the app never printed is not valid, in the words of the expired banner",
    async ({ realApp, browser }) => {
      // The page reports the server's refusal; it is the case under test.
      realApp.allowProblem(/WebSocket|401|403|invalid|not valid/i);
      const first = await realApp.open({ path: "/" });
      const origin = new URL(first.url()).origin;

      // A tab of its own, so it holds no launch token from an earlier page.
      const wrong = await browser.newPage();
      const wrongProblems: string[] = [];
      wrong.on("console", (message) => {
        if (message.type() === "error") wrongProblems.push(message.text());
      });
      await wrong.goto(`${origin}/#token=not-the-token`);
      await expect(
        wrong.getByText("This link is not valid. Open the app with the link omp-app printed.", {
          exact: true,
        }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(wrong.getByText("Could not reach the app")).toHaveCount(0);
      // All it logs is the refused connection.
      expect(wrongProblems.filter((text) => !/WebSocket|401|403/i.test(text))).toEqual([]);
      await wrong.context().close();

      expect(realApp.problems).toEqual([]);
    },
  );
});
