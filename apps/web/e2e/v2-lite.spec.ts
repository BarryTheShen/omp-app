import { createServer } from "node:http";
import { expect, type Page } from "@playwright/test";
import { realTest } from "./real-omp";

/**
 * The lite view (#2843): one chat and its message box at `/lite`, for another app's side panel. A whole turn works in
 * it at a narrow panel's size, it switches between the folder's recent chats, its theme follows the framing page's
 * `?theme=` without keeping it, only a page `OMP_APP_FRAME_ANCESTORS` names may frame it, and "Open in the full app"
 * opens the chat there.
 */

/**
 * The notes app's port: a loopback server the test starts, as a notes app on the same computer serves its own page (a
 * page the browser counts as public may not frame a loopback one at all, by Local Network Access). Picked once per
 * worker, before the app starts: the app reads the pages it allows at its start.
 */
const NOTES_PORT = 41_000 + Math.floor(Math.random() * 20_000);
/** The page allowed to frame the lite view. */
const NOTES_APP = `http://127.0.0.1:${NOTES_PORT}`;
/** The same server under another name: a page no one named. */
const OTHER_APP = `http://localhost:${NOTES_PORT}`;

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
/** A phone's width names the model in the empty box; a computer's says "Message omp". */
const ready = /^(Fake Model|Message omp)/;

async function send(page: Page, text: string): Promise<void> {
  await box(page).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

realTest.describe("new UI lite view", () => {
  realTest(
    "a narrow panel shows one chat and its box; a tool call, a question and Stop work, and recent chats switch",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
      const page = await realApp.open({ path: "/lite", context });
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
      // None of the full app's frame: no chat list or its button, no workspace tabs; the way to the full app instead.
      await expect(page.getByRole("link", { name: "Open in the full app" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Chats", exact: true })).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: "Chats" })).toHaveCount(0);
      await expect(page.getByRole("tablist", { name: "Workspaces" })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "New chat" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        360,
      );

      // A tool call, then the reply; the header names the chat by its first message.
      await send(page, "run_bash");
      await expect(page.getByText("tool said: fixture-tool")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("heading", { name: "run_bash" })).toBeVisible();

      // A question, answered.
      await send(page, "ask_user");
      const asked = page.getByRole("dialog", { name: "Questions from omp" });
      await expect(asked).toBeVisible({ timeout: 60_000 });
      await asked.getByRole("radio", { name: "Postgres" }).click();
      await asked.getByRole("button", { name: "Submit" }).click();
      await expect(asked).toBeHidden();
      await expect(page.getByText(/tool said: .*Postgres/)).toBeVisible({ timeout: 60_000 });

      // A slow step, stopped.
      await send(page, "slow_tool 30");
      const stop = page.getByRole("button", { name: "Stop" });
      await expect(stop).toBeVisible({ timeout: 60_000 });
      await stop.click();
      await expect(stop).toBeHidden({ timeout: 60_000 });
      await expect(page.getByText("tool said: slow-tool-done")).toHaveCount(0);

      // New chat starts an empty one; the chat left is in the recent chats, a search finds it by its title, and it comes
      // back as it was.
      await page.getByRole("button", { name: "New chat" }).click();
      await expect(page.getByRole("heading", { name: "New chat" })).toBeVisible();
      await expect(page.getByText("tool said: fixture-tool")).toHaveCount(0);
      await page.getByRole("heading", { name: "New chat" }).getByRole("button").click();
      await expect(page.getByRole("option", { name: "run_bash" })).toBeVisible();
      const find = page.getByRole("combobox", { name: "Find a chat" });
      await find.fill("no such chat");
      await expect(page.getByText('No chat\'s title has "no such chat".')).toBeVisible();
      await expect(page.getByRole("option")).toHaveCount(0);
      await find.fill("RUN_b");
      await page.getByRole("option", { name: "run_bash" }).click();
      await expect(page.getByRole("heading", { name: "run_bash" })).toBeVisible();
      await expect(page.getByText("tool said: fixture-tool")).toBeVisible({ timeout: 60_000 });
      await context.close();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "in a narrow panel the message box keeps one row: the chips shorten, and Send stays at the row's end",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({ viewport: { width: 420, height: 700 } });
      const page = await realApp.open({ path: "/lite", context });
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
      const sendButton = page.getByRole("button", { name: "Send" });
      const modelButton = page.getByRole("button", { name: /^Model: Fake Model/ });
      const thinking = page.getByRole("button", { name: /^Thinking: / });
      const plan = page.getByRole("button", { name: "Plan" });
      const middle = async (button: typeof sendButton): Promise<number> => {
        const at = await button.boundingBox();
        if (at === null) throw new Error("not shown");
        return at.y + at.height / 2;
      };
      for (const width of [420, 340, 300]) {
        await page.setViewportSize({ width, height: 700 });
        // Send is on the model's row, and nothing in the row runs past the box.
        await expect
          .poll(async () => Math.abs((await middle(sendButton)) - (await middle(modelButton))))
          .toBeLessThanOrEqual(2);
        const row = await sendButton.evaluate((button) => {
          const parent = button.parentElement;
          return parent === null ? null : { overflow: parent.scrollWidth - parent.clientWidth };
        });
        expect(row?.overflow).toBeLessThanOrEqual(1);
        // Below 22rem the thinking level and Plan are their icons alone; their names stay for screen readers.
        const narrow = width < 352;
        for (const chip of [thinking, plan]) {
          await expect(chip).toBeVisible();
          const at = await chip.boundingBox();
          if (at === null) throw new Error("not shown");
          if (narrow) expect(at.width).toBeLessThanOrEqual(40);
          else expect(at.width).toBeGreaterThan(40);
        }
      }
      await context.close();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the theme is the one the framing page asks for, and the full app's choice stays as it was",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/lite" });
      await page.evaluate(() => localStorage.setItem("omp-app.ui.theme", "tern-dark"));
      const origin = new URL(page.url()).origin;
      await page.goto(`${origin}/lite?theme=light`);
      await expect(page.locator("[data-app-root='true']")).toBeVisible();
      await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
      await page.goto(`${origin}/lite?theme=dark`);
      await expect(page.locator("[data-app-root='true']")).toBeVisible();
      await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      expect(await page.evaluate(() => localStorage.getItem("omp-app.ui.theme"))).toBe("tern-dark");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "Open in the full app opens the chat there, in front, and leaves the address clean",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/lite" });
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
      await send(page, "count_reply linked");
      await expect(page.getByText(/count-\d+ linked/)).toBeVisible({ timeout: 60_000 });
      const link = page.getByRole("link", { name: "Open in the full app" });
      await expect(link).toHaveAttribute("href", /^\/#chat=/);
      await expect(link).toHaveAttribute("target", "_blank");
      // This tab goes there: a new tab signs in with the device's pairing, which this run's browser does not have.
      await page.goto(new URL((await link.getAttribute("href")) ?? "", page.url()).toString());
      const chats = page.getByRole("navigation", { name: "Chats" });
      await expect(chats).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("[data-chat-pane]").getByText(/count-\d+ linked/)).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        chats.getByRole("button", { name: /^count_reply linked, open in a window/ }),
      ).toBeVisible();
      expect(new URL(page.url()).hash).not.toContain("chat=");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "Open in the desktop app hands the chat's link to the system and stays the arrow's choice; the window's script opens the chat in front",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/lite" });
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
      await send(page, "count_reply handed");
      await expect(page.getByText(/count-\d+ handed/)).toBeVisible({ timeout: 60_000 });
      // A browser tab until the panel chooses; the menu opens it in the desktop app, through its link, and keeps that.
      await expect(page.getByRole("link", { name: "Open in the full app" })).toBeVisible();
      await page.getByRole("button", { name: "Where the full app opens" }).click();
      await page.getByRole("menuitem", { name: "Open in the desktop app" }).click();
      const desktop = page.getByRole("link", { name: "Open in the desktop app" });
      const origin = new URL(page.url()).origin;
      const server = encodeURIComponent(origin).replaceAll(".", "\\.");
      const href = new RegExp(`^omp-app://chat/([0-9a-f-]{36})\\?server=${server}$`);
      await expect(desktop).toHaveAttribute("href", href);
      await expect(desktop).not.toHaveAttribute("target");
      const chat = href.exec((await desktop.getAttribute("href")) ?? "")?.[1] ?? "";
      // The system took the link: the panel stays where it is.
      expect(new URL(page.url()).pathname).toBe("/lite");
      // Loaded again, the panel keeps the choice and the chat it showed.
      await page.reload();
      await expect(page.getByText(/count-\d+ handed/)).toBeVisible({ timeout: 60_000 });
      await expect(desktop).toHaveAttribute("href", href);
      // A panel on a new chat: its link names the server alone until the chat has an id. (Opened by its address: after
      // the menu's omp-app:// navigation the test's browser takes no more clicks in this tab.)
      const fresh = new URL(page.url());
      fresh.searchParams.delete("chat");
      await page.goto(fresh.toString());
      await expect(page.getByRole("heading", { name: "New chat" })).toBeVisible({
        timeout: 60_000,
      });
      await expect(desktop).toHaveAttribute(
        "href",
        new RegExp(`^omp-app://open\\?server=${server}$`),
      );

      // The desktop window shows the full app; for the link it runs this script in the page (`chat_link.rs`).
      await page.goto(new URL("/", page.url()).toString());
      const chats = page.getByRole("navigation", { name: "Chats" });
      await expect(chats).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("[data-chat-pane]").getByText(/count-\d+ handed/)).toHaveCount(0);
      await page.evaluate(
        (id) => window.dispatchEvent(new CustomEvent("omp-app:open-chat", { detail: id })),
        chat,
      );
      await expect(page.locator("[data-chat-pane]").getByText(/count-\d+ handed/)).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        chats.getByRole("button", { name: /^count_reply handed, open in a window/ }),
      ).toBeVisible();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest.describe("framed by another app", () => {
    realTest.use({ serverEnv: { OMP_APP_FRAME_ANCESTORS: NOTES_APP } });

    realTest(
      "a page OMP_APP_FRAME_ANCESTORS names frames the lite view and chats in it; another page's frame is refused",
      async ({ realApp, browser }) => {
        const app = new URL((await realApp.open({ path: "/lite" })).url()).origin;
        // A side panel that frames the lite view, signed in with the launch link, under both of the server's names.
        const notesServer = createServer((_request, response) => {
          response.writeHead(200, { "Content-Type": "text/html" });
          response.end(
            `<!doctype html><title>notes</title><iframe title="omp" style="width:360px;height:700px;border:0" src="${app}/lite#token=${encodeURIComponent(realApp.token)}"></iframe>`,
          );
        });
        await new Promise<void>((resolve, reject) => {
          notesServer.once("error", reject);
          notesServer.listen(NOTES_PORT, "127.0.0.1", resolve);
        });
        const context = await browser.newContext();
        try {
          const notes = await context.newPage();
          await notes.goto(`${NOTES_APP}/notes`);
          const framed = notes.frameLocator('iframe[title="omp"]');
          await expect(framed.getByRole("textbox", { name: "Message" })).toHaveAttribute(
            "placeholder",
            ready,
            { timeout: 120_000 },
          );
          await expect(framed.getByRole("link", { name: "Open in the full app" })).toBeVisible();
          await framed.getByRole("textbox", { name: "Message" }).fill("count_reply framed");
          await framed.getByRole("button", { name: "Send" }).click();
          await expect(framed.getByText(/count-\d+ framed/)).toBeVisible({ timeout: 60_000 });

          // A page no one named: the browser refuses the frame. The page's load waits for its frame, and the app's
          // page has its root from the start, so a frame that loaded the app would have it by now.
          await notes.goto(`${OTHER_APP}/notes`);
          await expect(notes.locator('iframe[title="omp"]')).toBeAttached();
          await expect(notes.frameLocator('iframe[title="omp"]').locator("#root")).toHaveCount(0);
        } finally {
          await context.close();
          notesServer.close();
        }
        expect(realApp.problems).toEqual([]);
      },
    );
  });

  realTest(
    "a new chat whose omp stopped before anything was sent still sends: a new chat starts in its place",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/lite" });
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
      // The empty chat's omp stops, as when the server let go of a chat no page held while the computer slept: an
      // empty chat leaves no file to go on from.
      const started = [
        ...realApp.log().matchAll(/omp\.process thread=(\S+) status=running pid=(\d+)/g),
      ].at(-1);
      expect(started).toBeDefined();
      const [, thread = "", pid = "0"] = started ?? [];
      process.kill(Number(pid), "SIGKILL");
      await expect
        .poll(
          () =>
            new RegExp(`omp\\.process thread=${thread} status=(exited|error|stopped)`).test(
              realApp.log(),
            ),
          { timeout: 30_000 },
        )
        .toBe(true);

      // What the box sends reaches a chat: the reply comes, and nothing says it was not sent.
      await send(page, "hello");
      await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(/^Not sent/)).toHaveCount(0);
      await expect(box(page)).toHaveValue("");
    },
  );

  realTest(
    "loading the page again shows the chat it showed, not the one its address named when the panel was built",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/lite" });
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
      await send(page, "hello");
      await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
      const link = await page
        .getByRole("link", { name: "Open in the full app" })
        .getAttribute("href");
      const first = decodeURIComponent(link?.split("#chat=")[1] ?? "");
      expect(first).not.toBe("");

      // The panel as a host builds it: its address names the chat it opens first.
      const built = new URL(page.url());
      built.searchParams.set("chat", first);
      await page.goto(built.toString());
      await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });

      // Another chat, then the page loaded again (as the update's Reload does): the chat shown comes back.
      await page.getByRole("button", { name: "New chat" }).click();
      await send(page, "count_reply second");
      await expect(page.getByText(/count-\d+ second/)).toBeVisible({ timeout: 60_000 });
      await page.reload();
      await expect(page.getByText(/count-\d+ second/)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText("pong", { exact: true })).toHaveCount(0);

      // A new chat with nothing in it yet: loading again starts a new chat.
      await page.getByRole("button", { name: "New chat" }).click();
      await expect(page.getByRole("heading", { name: "New chat" })).toBeVisible();
      await page.reload();
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
      await expect(page.getByRole("heading", { name: "New chat" })).toBeVisible();
      expect(realApp.problems).toEqual([]);
    },
  );
});
