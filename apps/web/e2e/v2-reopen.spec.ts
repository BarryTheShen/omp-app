import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * The new UI (`apps/ui`, under `/v2/`) on real omp, when the app's server is slow: a chat left a moment ago comes back
 * as the page kept it open, a chat opened before a reload shows at once from what this browser kept, a chat the pointer
 * rests on is read ahead, and a new chat takes a message before it is ready.
 */
realTest.describe("new UI reopening and typing ahead", () => {
  realTest.setTimeout(240_000);
  realTest.use({ seedSessions: 3 });

  /** Holds the page's calls that match `slow` for `ms` before they reach the server; records every call sent. */
  async function slowServer(page: Page, ms: number) {
    const state = { slow: null as RegExp | null, sent: [] as string[] };
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        const text = String(message);
        state.sent.push(text);
        if (state.slow?.test(text) === true) setTimeout(() => server.send(message), ms);
        else server.send(message);
      });
      server.onMessage((message) => ws.send(message));
    });
    return state;
  }
  type SlowServer = Awaited<ReturnType<typeof slowServer>>;
  const fileReads = (server: SlowServer) =>
    server.sent.filter((frame) => frame.includes('"method":"readEntryWindow"')).length;

  const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });
  const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });

  realTest(
    "a chat left a moment ago comes back as it was at once, while the server is slow, without reading its file again",
    async ({ realApp }) => {
      let server!: SlowServer;
      const page = await realApp.open({
        path: "/",
        beforeLoad: async (target: Page) => {
          server = await slowServer(target, 5_000);
        },
      });
      const box = page.getByRole("textbox", { name: "Message" });
      await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
      await expect(transcript(page).getByText("Seeded chat 1")).toBeVisible({ timeout: 60_000 });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 60_000 });
      await chats(page).getByRole("button", { name: "Seeded chat 2" }).click();
      await expect(transcript(page).getByText("Seeded chat 2")).toBeVisible({ timeout: 60_000 });

      // From now on, opening a chat and reading its file each take the server five seconds.
      server.slow = /"method":"(open|readEntryWindow)"/;
      const readsBefore = fileReads(server);
      await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
      await expect(transcript(page).getByText("Seeded chat 1")).toBeVisible({ timeout: 1_500 });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 1_500 });
      // The page kept it open: its file is not read again to show it.
      expect(fileReads(server)).toBe(readsBefore);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "after a reload, a chat opened before shows at once while the server is slow to read its file; resting on a chat reads it ahead",
    async ({ realApp }) => {
      let server!: SlowServer;
      const page = await realApp.open({
        path: "/",
        beforeLoad: async (target: Page) => {
          server = await slowServer(target, 5_000);
        },
      });
      await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
      await expect(transcript(page).getByText("Seeded chat 1")).toBeVisible({ timeout: 60_000 });
      await chats(page).getByRole("button", { name: "Seeded chat 2" }).click();
      await expect(transcript(page).getByText("Seeded chat 2")).toBeVisible({ timeout: 60_000 });
      // A reload ends the chats the page kept open; what this browser kept of each chat stays.
      await page.reload();
      await expect(transcript(page).getByText("Seeded chat 2")).toBeVisible({ timeout: 60_000 });

      // From now on, reading a chat's file takes the server five seconds.
      server.slow = /"method":"readEntryWindow"/;
      const readsBefore = fileReads(server);
      await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
      await expect(transcript(page).getByText("Seeded chat 1")).toBeVisible({ timeout: 1_500 });
      // The file was asked for (and is held back), so what shows came from this browser.
      expect(fileReads(server)).toBeGreaterThan(readsBefore);

      // Resting the pointer on a chat not touched yet asks for its file before any click.
      const beforeRest = fileReads(server);
      await chats(page).getByRole("button", { name: "Seeded chat 3" }).hover();
      await expect.poll(() => fileReads(server)).toBeGreaterThan(beforeRest);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a new chat takes a message typed before it is ready and sends it once it is",
    async ({ realApp }) => {
      let server!: SlowServer;
      const page = await realApp.open({
        path: "/",
        beforeLoad: async (target: Page) => {
          server = await slowServer(target, 4_000);
        },
      });
      // Opening a chat on omp takes the server four seconds.
      const opening = /"port":"A0\.chatSession","method":"open"/;
      server.slow = opening;
      await chats(page).getByRole("button", { name: "New chat" }).click();
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Opening the chat…");
      await expect.poll(() => server.sent.some((frame) => opening.test(frame))).toBe(true);
      await box.fill("hello");
      await box.press("Enter");
      await expect(page.getByText("Sends once the chat is open")).toBeVisible();
      await expect(box).toHaveValue("hello");

      await expect(transcript(page).getByText("pong")).toBeVisible({ timeout: 60_000 });
      await expect(box).toHaveValue("");
      await expect(page.getByText("Sends once the chat is open")).toHaveCount(0);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the chat list and the model menu show what they showed last at once while the server is slow, also after a reload",
    async ({ realApp }) => {
      let server!: SlowServer;
      const page = await realApp.open({
        path: "/",
        beforeLoad: async (target: Page) => {
          server = await slowServer(target, 5_000);
        },
      });
      const box = page.getByRole("textbox", { name: "Message" });
      // Its provider's row: the model may be listed under Recent too.
      const fakeModel = page
        .getByRole("group", { name: "fake" })
        .getByRole("option", { name: /Fake Model/ });
      await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 60_000 });
      await page.getByRole("button", { name: /^Model: / }).click();
      await expect(fakeModel).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press("Escape");

      // From now on, listing the chats and the model menu's models each take the server five seconds.
      server.slow = /"method":"listSessions"|get_model_menu/;
      await page.reload();
      await expect(chats(page).getByRole("button", { name: "Seeded chat 2" })).toBeVisible({
        timeout: 1_500,
      });
      await chats(page).getByRole("button", { name: "Seeded chat 2" }).click();
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 60_000 });
      await page.getByRole("button", { name: /^Model: / }).click();
      await expect(fakeModel).toBeVisible({ timeout: 1_500 });
      await page.keyboard.press("Escape");

      expect(realApp.problems).toEqual([]);
    },
  );
});
