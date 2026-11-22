import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

// The server with agent access on, as a server that offers it runs: it needs its https address too (a stand-in here).
realTest.use({
  serverEnv: { OMP_APP_DEVICE_ACCESS: "1", OMP_APP_REMOTE_ORIGIN: "https://omp.example.test" },
});

const ASK = {
  id: "0123456789abcdef",
  path: "/home/person/workspace",
  write: true,
  why: "Read the build logs",
  server: "other.example",
  chat: "Fix the build",
};

type Call = [string, Record<string, unknown> | null];

/**
 * The desktop window's command bridge for agent access on its own computer (`access.rs`), faked where Tauri puts it: the
 * computer is set up and linked to another server (so this window controls it), access is on, and one agent asks for a
 * folder. The folder commands change the fake as the computer's agent does, and answer with its status; `addAsk` adds a
 * request and the event that tells the panel.
 */
const fakeComputer = (target: Page) =>
  target.addInitScript((ask) => {
    const calls: [string, unknown][] = [];
    const folders: {
      asks: { id: string; path: string; write: boolean; why: string; chat?: string }[];
      shared: { path: string; write: boolean; server?: string; chat?: string | null }[];
    } = { asks: [ask], shared: [] };
    const events: { n: number; event: Record<string, unknown> }[] = [];
    const linked = { server: "https://other.example", alias: "laptop" };
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
      folders: structuredClone(folders),
    });
    Object.assign(window, {
      windowCalls: calls,
      addAsk: (next: { id: string; path: string; write: boolean; why: string }) => {
        folders.asks.push(next);
        events.push({ n: events.length + 1, event: { type: "folders" } });
      },
      /** A chat's session runs a command, as the computer's agent tells it (with the chat the server named). */
      addRun: (chat: string) => {
        events.push({
          n: events.length + 1,
          event: {
            type: "wrapper",
            chat,
            event: {
              type: "start",
              stream: 4,
              command: "make",
              startedAt: new Date().toISOString(),
            },
          },
        });
      },
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: Record<string, unknown>) => {
          calls.push([command, args ?? null]);
          if (command === "access_here")
            return { installed: true, setUp: true, linked, here: false, name: "laptop" };
          if (command === "access_status") return status();
          if (command === "access_events")
            return events.filter((each) => each.n > Number(args?.after ?? 0));
          if (command === "access_allow_folder") {
            const asked = folders.asks.find((each) => each.id === args?.id);
            folders.asks = folders.asks.filter((each) => each.id !== args?.id);
            // The shared folder keeps the chat that asked, as the computer's guard records it.
            if (asked !== undefined)
              folders.shared.push({
                path: asked.path,
                write: args?.write === true,
                server: "other.example",
                chat: asked.chat ?? null,
              });
            return status();
          }
          if (command === "access_deny_folder") {
            folders.asks = folders.asks.filter((each) => each.id !== args?.id);
            return status();
          }
          if (command === "access_remove_folder") {
            folders.shared = folders.shared.filter((each) => each.path !== args?.path);
            return status();
          }
          return null;
        },
      },
    });
  }, ASK);

const windowCalls = (page: Page): Promise<Call[]> =>
  page.evaluate(() => (window as unknown as { windowCalls: Call[] }).windowCalls);

realTest.describe("new UI: an agent asks for a folder of this computer (#20, PLAN §7d)", () => {
  realTest.setTimeout(240_000);

  realTest(
    "the request names the chat that asked and shows its reason and what changes can mean; allowed to read, the folder is listed as shared by that chat and Remove stops it; another, from no named chat, is denied",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/", beforeLoad: fakeComputer });
      await page.getByRole("button", { name: "Agent access", exact: true }).click();
      const panel = page
        .getByRole("complementary", { name: "Side panel" })
        .getByRole("tabpanel", { name: "Agent access" });
      const computer = panel.getByRole("region", { name: "This computer" });
      const request = computer
        .getByRole("list", { name: "Folder requests" })
        .getByRole("listitem", { name: `Request for ${ASK.path}` });
      await expect(request).toContainText(
        `The chat \u201c${ASK.chat}\u201d on ${ASK.server} asks to read and change the files in ${ASK.path}.`,
      );
      await expect(request).toContainText(`Reason given: ${ASK.why}`);
      await expect(request).toContainText(
        "Changed files can include ones that run later, such as a project's scripts or Git hooks.",
      );
      await page.screenshot({ path: realTest.info().outputPath("folder-request.png") });

      // Read only, though changes were asked for: the window is asked for exactly that.
      await request.getByRole("button", { name: "Allow reading only" }).click();
      await expect
        .poll(() => windowCalls(page))
        .toContainEqual(["access_allow_folder", { id: ASK.id, write: false }]);
      await expect(computer.getByRole("list", { name: "Folder requests" })).toHaveCount(0);
      const shared = computer.getByRole("list", { name: "Shared folders" });
      await expect(shared.getByRole("listitem")).toHaveText([
        `${ASK.path}Read only, asked for by \u201c${ASK.chat}\u201d on ${ASK.server}Remove`,
      ]);
      await page.screenshot({ path: realTest.info().outputPath("folder-shared.png") });

      await shared.getByRole("button", { name: `Stop sharing ${ASK.path}` }).click();
      await expect
        .poll(() => windowCalls(page))
        .toContainEqual(["access_remove_folder", { path: ASK.path }]);
      await expect(computer.getByRole("list", { name: "Shared folders" })).toHaveCount(0);

      // A request to read only, told by the computer's agent while the panel is open: Allow and Deny only.
      const next = { id: "fedcba9876543210", path: "/home/person/notes", write: false, why: "" };
      await page.evaluate((ask) => {
        (window as unknown as { addAsk: (ask: unknown) => void }).addAsk(ask);
      }, next);
      const second = computer.getByRole("listitem", { name: `Request for ${next.path}` });
      await expect(second).toContainText(`An agent asks to read the files in ${next.path}.`);
      await expect(second.getByRole("button")).toHaveText(["Allow", "Deny"]);
      await second.getByRole("button", { name: "Deny" }).click();
      await expect
        .poll(() => windowCalls(page))
        .toContainEqual(["access_deny_folder", { id: next.id }]);
      await expect(second).toHaveCount(0);

      // A session the server opened for a chat is named by it.
      await page.evaluate((chat) => {
        (window as unknown as { addRun: (chat: string) => void }).addRun(chat);
      }, ASK.chat);
      await expect(
        computer
          .getByRole("list", { name: "Agent sessions on this computer" })
          .getByRole("listitem")
          .first(),
      ).toContainText(`\u201c${ASK.chat}\u201d, session 4`);
      expect(realApp.problems).toEqual([]);
    },
  );
});
