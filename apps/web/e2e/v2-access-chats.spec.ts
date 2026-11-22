import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

// The server with agent access on, as a server that offers it runs: it needs its https address too (a stand-in here).
realTest.use({
  serverEnv: { OMP_APP_DEVICE_ACCESS: "1", OMP_APP_REMOTE_ORIGIN: "https://omp.example.test" },
});

const REQUEST = { threadId: "thread-fix", chat: "Fix the build", server: "https://lab.example" };

type Call = [string, Record<string, unknown> | null];

/**
 * The desktop window's command bridge for agent access on its own computer (`access.rs`), faked where Tauri puts it: the
 * computer is set up, linked to another server (so this window controls it), on, and one chat asks to reach it. The
 * chat commands change the fake as the computer's agent does and answer with its status; `addRequest` adds a request and
 * the event that tells the panel.
 */
const fakeComputer = (target: Page) =>
  target.addInitScript((request) => {
    const calls: [string, unknown][] = [];
    const chats: {
      requests: (typeof request)[];
      granted: (typeof request & { grantedAt: string })[];
    } = { requests: [request], granted: [] };
    const events: { n: number; event: Record<string, unknown> }[] = [];
    const linked = { server: "https://lab.example", alias: "laptop" };
    const shared: { path: string; write: boolean }[] = [];
    const status = () => ({
      enrolled: linked,
      state: {
        on: true,
        until: new Date(Date.now() + 3_600_000).toISOString(),
        sessions: 0,
        sudoUntil: null,
      },
      leftSeconds: 3600,
      linked: true,
      review: { pending: false, changed: [] },
      folders: { asks: [], shared: structuredClone(shared) },
      chats: structuredClone(chats),
    });
    Object.assign(window, {
      windowCalls: calls,
      addRequest: (next: typeof request) => {
        chats.requests.push(next);
        events.push({ n: events.length + 1, event: { type: "chats" } });
      },
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: Record<string, unknown>) => {
          calls.push([command, args ?? null]);
          if (command === "access_here")
            return { installed: true, setUp: true, linked, here: false, name: "laptop" };
          if (command === "access_status") return status();
          if (command === "access_events")
            return events.filter((each) => each.n > Number(args?.after ?? 0));
          const id = args?.threadId;
          if (command === "access_allow_chat") {
            const asked = chats.requests.find((each) => each.threadId === id);
            chats.requests = chats.requests.filter((each) => each.threadId !== id);
            if (asked !== undefined) chats.granted.push({ ...asked, grantedAt: "now" });
            return status();
          }
          if (command === "access_deny_chat") {
            chats.requests = chats.requests.filter((each) => each.threadId !== id);
            return status();
          }
          if (command === "access_remove_chat") {
            chats.granted = chats.granted.filter((each) => each.threadId !== id);
            return status();
          }
          if (command === "access_add_chat") {
            chats.granted.push({
              threadId: String(id),
              chat: String(args?.chat),
              server: linked.server,
              grantedAt: "now",
            });
            return status();
          }
          if (command === "access_share_folder") {
            const path = String(args?.path).replace(/^~/, "/home/person");
            shared.push({ path, write: args?.write === true });
            return status();
          }
          return null;
        },
      },
    });
  }, REQUEST);

const windowCalls = (page: Page): Promise<Call[]> =>
  page.evaluate(() => (window as unknown as { windowCalls: Call[] }).windowCalls);

realTest.describe("new UI: a chat asks to reach this computer (#20, PLAN §7f)", () => {
  realTest.setTimeout(240_000);

  realTest(
    "a chat's request names the chat and its server; allowed, it is listed under Chats with access and Remove takes it away; another is denied",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/", beforeLoad: fakeComputer });
      await page.getByRole("button", { name: "Agent access", exact: true }).click();
      const computer = page
        .getByRole("complementary", { name: "Side panel" })
        .getByRole("tabpanel", { name: "Agent access" })
        .getByRole("region", { name: "This computer" });
      const request = computer
        .getByRole("list", { name: "Chat requests" })
        .getByRole("listitem", { name: `Request from ${REQUEST.chat}` });
      await expect(request).toContainText(
        "The chat Fix the build on lab.example asks to reach this computer.",
      );
      await expect(request).toContainText("until you remove it");
      await page.screenshot({ path: realTest.info().outputPath("chat-request.png") });

      await request.getByRole("button", { name: "Allow" }).click();
      await expect
        .poll(() => windowCalls(page))
        .toContainEqual(["access_allow_chat", { threadId: REQUEST.threadId }]);
      await expect(computer.getByRole("list", { name: "Chat requests" })).toHaveCount(0);
      const allowed = computer.getByRole("list", { name: "Chats with access" });
      await expect(allowed.getByRole("listitem")).toHaveText(["Fix the buildlab.exampleRemove"]);
      await page.screenshot({ path: realTest.info().outputPath("chats-with-access.png") });

      await allowed.getByRole("button", { name: "Take access away from Fix the build" }).click();
      await expect
        .poll(() => windowCalls(page))
        .toContainEqual(["access_remove_chat", { threadId: REQUEST.threadId }]);
      await expect(computer.getByRole("list", { name: "Chats with access" })).toHaveCount(0);

      // Another chat asks while the panel is open: Deny.
      const next = { threadId: "thread-other", chat: "Other work", server: "https://lab.example" };
      await page.evaluate((each) => {
        (window as unknown as { addRequest: (each: unknown) => void }).addRequest(each);
      }, next);
      const second = computer.getByRole("listitem", { name: `Request from ${next.chat}` });
      await expect(second.getByRole("button")).toHaveText(["Allow", "Deny"]);
      await second.getByRole("button", { name: "Deny" }).click();
      await expect
        .poll(() => windowCalls(page))
        .toContainEqual(["access_deny_chat", { threadId: next.threadId }]);
      await expect(second).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest.describe("given directly, without a request", () => {
    realTest.use({ seedSessions: 2 });

    realTest(
      "the open chat is offered first and recent ones after; a folder is shared by its path; each goes to the computer",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/", beforeLoad: fakeComputer });
        await page
          .getByRole("navigation", { name: "Chats" })
          .getByRole("button", { name: /^Seeded chat 2/ })
          .click();
        await page.getByRole("button", { name: "Agent access", exact: true }).click();
        const computer = page
          .getByRole("complementary", { name: "Side panel" })
          .getByRole("tabpanel", { name: "Agent access" })
          .getByRole("region", { name: "This computer" });
        const pick = computer.getByRole("combobox", { name: "Chat to give access" });
        await expect(pick).toHaveText(/This chat: Seeded chat 2/, { timeout: 30_000 });
        await pick.click();
        await expect(page.getByRole("option")).toHaveText([
          "This chat: Seeded chat 2",
          "Seeded chat 1",
        ]);
        await page.keyboard.press("Escape");
        await page.screenshot({ path: realTest.info().outputPath("give-access.png") });

        await computer.getByRole("button", { name: "Give access" }).click();
        await expect
          .poll(async () =>
            (await windowCalls(page)).find(([command]) => command === "access_add_chat"),
          )
          .toEqual(["access_add_chat", { threadId: expect.any(String), chat: "Seeded chat 2" }]);
        const allowed = computer.getByRole("list", { name: "Chats with access" });
        await expect(allowed.getByRole("listitem")).toHaveText(["Seeded chat 2lab.exampleRemove"]);
        // Given: no longer offered; the next recent chat is.
        await expect(pick).toHaveText(/^Seeded chat 1/);

        const share = computer.getByRole("form", { name: "Share a folder" });
        await share.getByRole("textbox", { name: "Share a folder" }).fill("~/projects/app");
        await share.getByRole("button", { name: "Share, reading and changes" }).click();
        await expect
          .poll(() => windowCalls(page))
          .toContainEqual(["access_share_folder", { path: "~/projects/app", write: true }]);
        await expect(
          computer.getByRole("list", { name: "Shared folders" }).getByRole("listitem"),
        ).toHaveText(["/home/person/projects/appRead and changeRemove"]);
        await page.screenshot({ path: realTest.info().outputPath("given.png") });
        expect(realApp.problems).toEqual([]);
      },
    );
  });
});
