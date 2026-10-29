import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * The new UI (`apps/ui`, under `/v2/`) on real omp, when the app's server is slow: a chat opened before shows at once
 * from what this browser kept, a chat the pointer rests on is read ahead, and a new chat takes a message before it is
 * ready.
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
    "a chat opened before shows at once while the server is slow to read its file; resting on a chat reads it ahead",
    async ({ realApp }) => {
      let server!: SlowServer;
      const page = await realApp.open({
        path: "/v2/",
        beforeLoad: async (target: Page) => {
          server = await slowServer(target, 5_000);
        },
      });
      await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
      await expect(transcript(page).getByText("Seeded chat 1")).toBeVisible({ timeout: 60_000 });
      await chats(page).getByRole("button", { name: "Seeded chat 2" }).click();
      await expect(transcript(page).getByText("Seeded chat 2")).toBeVisible({ timeout: 60_000 });
      await expect(transcript(page).getByText("Seeded chat 1")).toHaveCount(0);

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
        path: "/v2/",
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
});
