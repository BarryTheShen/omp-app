import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

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
      // Its window closes, and the blank one left takes the next chat: only that one is open at the reload (#2831).
      await page.getByRole("textbox", { name: "Message" }).press("Control+Shift+W");
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
      await startNewChat(page);
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
      // Its provider's row: the model may be listed under Recent too. The menu builds its first rows when it opens,
      // and a search finds this one in the list it has.
      const fakeModel = page
        .getByRole("group", { name: "fake" })
        .getByRole("option", { name: /Fake Model/ });
      const findModel = page.getByPlaceholder("Find a model");
      await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 60_000 });
      await page.getByRole("button", { name: /^Model: / }).click();
      await findModel.fill("fake model");
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
      await findModel.fill("fake model");
      await expect(fakeModel).toBeVisible({ timeout: 1_500 });
      await page.keyboard.press("Escape");

      expect(realApp.problems).toEqual([]);
    },
  );

  /** A chat with a finished turn for each word, started on a page of its own; its row's name is its first message. */
  async function chatWithTurns(
    realApp: { open: (options: { path: string }) => Promise<Page> },
    words: string[],
  ) {
    const page = await realApp.open({ path: "/" });
    await startNewChat(page);
    const box = page.getByRole("textbox", { name: "Message" });
    await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
    for (const word of words) {
      await box.fill(`count_reply ${word}`);
      await box.press("Enter");
      await expect(transcript(page).getByText(new RegExp(`count-\\d+ ${word}`))).toBeVisible({
        timeout: 60_000,
      });
    }
    return { page, box };
  }

  realTest(
    "a chat with finished turns, opened on another page, reads its file once, not again for each turn the server replays (#2768)",
    async ({ realApp }) => {
      await chatWithTurns(realApp, ["one", "two", "three"]);
      let server!: SlowServer;
      const page = await realApp.open({
        path: "/",
        beforeLoad: async (target: Page) => {
          server = await slowServer(target, 0);
        },
      });
      await chats(page)
        .getByRole("button", { name: /count_reply one/ })
        .first()
        .click();
      await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
        "placeholder",
        "Message omp",
        {
          timeout: 60_000,
        },
      );
      await expect(transcript(page).getByText(/count-\d+ three/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Edit this message" })).toHaveCount(3);
      // What the replay would have asked for has gone out by now.
      await page.waitForTimeout(1_500);
      expect(fileReads(server)).toBe(1);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a turn that ends while a page subscribes to the chat shows there, read back from the file so it can be edited (#2768)",
    async ({ realApp }) => {
      const first = await chatWithTurns(realApp, ["early"]);
      let server!: SlowServer;
      const page = await realApp.open({
        path: "/",
        beforeLoad: async (target: Page) => {
          server = await slowServer(target, 15_000);
        },
      });
      // The page's subscription to the chat's events is held while a turn runs and ends on the first page: the page read
      // the file's window before it, so the turn comes only in the server's replay.
      server.slow = /^(?=.*"type":"subscribe")(?=.*A0\.chatSession\/event\/)/;
      await chats(page)
        .getByRole("button", { name: /count_reply early/ })
        .first()
        .click();
      await expect
        .poll(() => server.sent.some((frame) => server.slow?.test(frame) === true), {
          timeout: 30_000,
        })
        .toBe(true);
      await first.box.fill("count_reply late");
      await first.box.press("Enter");
      await expect(transcript(first.page).getByText(/count-\d+ late/)).toBeVisible({
        timeout: 60_000,
      });

      await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
        "placeholder",
        "Message omp",
        {
          timeout: 60_000,
        },
      );
      await expect(transcript(page).getByText(/count-\d+ late/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Edit this message" })).toHaveCount(2, {
        timeout: 30_000,
      });
      expect(fileReads(server)).toBe(2);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a chat's state is asked with its subscription, not after the subscription's answer, so a slow link waits one round trip less (#2768)",
    async ({ realApp }) => {
      const sent: { at: number; text: string }[] = [];
      const received: { at: number; text: string }[] = [];
      const page = await realApp.open({
        path: "/",
        beforeLoad: (target: Page) =>
          target.routeWebSocket(/\/ws/, (ws) => {
            const server = ws.connectToServer();
            ws.onMessage((message) => {
              sent.push({ at: Date.now(), text: String(message) });
              server.send(message);
            });
            // Every answer reaches the page 400 ms late, as on a phone's slow link.
            server.onMessage((message) =>
              setTimeout(() => {
                received.push({ at: Date.now(), text: String(message) });
                ws.send(message);
              }, 400),
            );
          }),
      });
      await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
      await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
        "placeholder",
        "Message omp",
        { timeout: 60_000 },
      );

      type Frame = {
        type?: string;
        id?: unknown;
        stream?: string;
        args?: { method?: string; threadId?: string };
      };
      const parse = (text: string): Frame => {
        try {
          return JSON.parse(text) as Frame;
        } catch {
          return {};
        }
      };
      const out = sent.map(({ at, text }) => ({ at, frame: parse(text) }));
      // Each chat opened: its first state read, and its subscription's answer.
      const opens = [
        ...new Set(
          out.flatMap(({ frame }) =>
            frame.type === "call" && frame.args?.method === "get_state" && frame.args.threadId
              ? [frame.args.threadId]
              : [],
          ),
        ),
      ].map((threadId) => {
        const state = out.find(
          ({ frame }) => frame.args?.method === "get_state" && frame.args.threadId === threadId,
        );
        const subscribe = out.find(
          ({ frame }) =>
            frame.type === "subscribe" && frame.stream === `A0.chatSession/event/${threadId}`,
        );
        const answer = received.find(({ text }) => parse(text).id === subscribe?.frame.id);
        return { asked: state?.at, answered: answer?.at };
      });
      expect(opens.length).toBeGreaterThan(0);
      for (const { asked, answered } of opens) {
        expect(answered).toBeDefined();
        expect(asked ?? Number.POSITIVE_INFINITY).toBeLessThan(answered ?? 0);
      }
      expect(realApp.problems).toEqual([]);
    },
  );
});
