import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/** A 1 x 1 PNG, as the desktop window's clipboard command answers it. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** The window's `servers` answer: it shows a server on another computer, and knows one more. */
const SERVERS = {
  current: "devbox.tail1234.ts.net",
  remote: ["devbox.tail1234.ts.net", "lab.tail1234.ts.net"],
};
/** The window's refusal of a link of another shape (`remote.rs`). */
const LINK_SHAPE = "the link must look like https://<computer>.<tailnet>.ts.net/#token=<token>";
const LINK = "https://lab.tail1234.ts.net/v2/#token=abc";

type Call = [string, Record<string, unknown> | null];

/**
 * The window's command bridge, faked where Tauri puts it on the window's pages (`window.__TAURI_INTERNALS__`): it
 * records each command with its arguments and answers as the window does; the link "not a link" is refused. The files a
 * file manager copied are `window.copiedFiles` (none unless a test puts some there).
 */
const fakeWindow = (target: Page) =>
  target.addInitScript(
    ({ png, servers, refusal }) => {
      const calls: [string, unknown][] = [];
      const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
      const copied = (): { name: string; text: string }[] =>
        (window as unknown as { copiedFiles?: { name: string; text: string }[] }).copiedFiles ?? [];
      Object.assign(window, {
        windowCalls: calls,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push([command, args ?? null]);
            if (command === "read_clipboard_png") return bytes.buffer;
            if (command === "list_clipboard_files")
              return copied().map((file) => ({ name: file.name, size: file.text.length }));
            if (command === "read_clipboard_file") {
              const file = copied()[Number(args?.index)];
              if (file === undefined) throw "The clipboard no longer holds that file.";
              return new TextEncoder().encode(file.text).buffer;
            }
            if (command === "servers") return servers;
            if (command === "connect_server" && args?.link === "not a link") throw refusal;
            return null;
          },
        },
      });
    },
    { png: PNG, servers: SERVERS, refusal: LINK_SHAPE },
  );

const windowCalls = (page: Page): Promise<Call[]> =>
  page.evaluate(() => (window as unknown as { windowCalls: Call[] }).windowCalls);

/**
 * The new UI (`apps/ui`, under `/v2/`) in the desktop window, with the window's command bridge faked. The window's own
 * behaviour is the desktop smoke test's.
 */
realTest.describe("new UI in the desktop window", () => {
  realTest.setTimeout(240_000);

  const settingsButton = (page: Page) =>
    page.getByRole("button", { name: "Settings", exact: true });
  const appSettings = (page: Page) =>
    page.getByRole("dialog", { name: "Settings" }).getByRole("region", { name: "App settings" });
  const linkField = (page: Page) =>
    appSettings(page).getByRole("textbox", { name: "Connect to another server" });

  async function newChat(page: Page) {
    await startNewChat(page);
    const box = page.getByRole("textbox", { name: "Message" });
    await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
    return box;
  }

  realTest(
    "a picture pasted in the window is read from the window's clipboard; pasted text stays text",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/", beforeLoad: fakeWindow });
      const box = await newChat(page);
      const calls = async () => (await windowCalls(page)).map(([command]) => command);
      // WebKitGTK's paste event: text when text was copied, nothing at all for a copied picture.
      const paste = (text: string) =>
        box.evaluate((element, value) => {
          const data = new DataTransfer();
          if (value !== "") data.setData("text/plain", value);
          element.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
          );
        }, text);

      await paste("plain words");
      expect(await calls()).toEqual([]);
      // Nothing at all: the window is asked for copied files first, then for a picture (#2833).
      await paste("");
      await expect(page.getByRole("button", { name: "Remove Pasted image 1.png" })).toBeVisible();
      expect(await calls()).toEqual(["list_clipboard_files", "read_clipboard_png"]);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a file a file manager copied, pasted in the window, is read from the window's clipboard and uploaded; a copied path alone goes in as text (#2833)",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/", beforeLoad: fakeWindow });
      const box = await newChat(page);
      const calls = async () => (await windowCalls(page)).map(([command]) => command);
      // WebKitGTK's paste event for a file manager's copy: the file's path as text, or nothing.
      const paste = (text: string) =>
        box.evaluate((element, value) => {
          const data = new DataTransfer();
          if (value !== "") data.setData("text/plain", value);
          element.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
          );
        }, text);

      // A path copied as text, with no file on the clipboard: the path goes in as text.
      await paste("/home/someone/notes 2833.txt");
      await expect(box).toHaveValue("/home/someone/notes 2833.txt");
      expect(await calls()).toEqual(["list_clipboard_files"]);
      await box.fill("");

      // The file itself on the clipboard: it is read and uploaded to the chat's folder, its path not typed.
      await page.evaluate(() =>
        Object.assign(window, {
          copiedFiles: [{ name: "notes 2833.txt", text: "copied from the file manager\n" }],
        }),
      );
      await paste("/home/someone/notes 2833.txt");
      const attached = page.getByRole("list", { name: "Attachments" });
      await expect(
        attached.getByRole("listitem").filter({ hasText: "notes 2833.txt" }),
      ).toContainText("29 B", { timeout: 30_000 });
      await expect(box).toHaveValue("");
      expect(await calls()).toEqual([
        "list_clipboard_files",
        "list_clipboard_files",
        "read_clipboard_file",
      ]);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the App tab lists the window's servers: one click opens one, a pasted link connects, a refused link says why",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/", beforeLoad: fakeWindow });
      await settingsButton(page).click();
      const app = appSettings(page);
      await expect(app.getByRole("button", { name: "Use this computer's server" })).toBeVisible();
      const lab = app.getByRole("button", { name: "Open the server on lab.tail1234.ts.net" });
      await expect(lab).toBeVisible();
      // The server the window shows is named, without a button.
      await expect(app.getByText("devbox.tail1234.ts.net")).toBeVisible();
      await expect(app.getByText("Open now")).toHaveCount(1);
      await expect(app.getByRole("button", { name: /devbox/ })).toHaveCount(0);

      const connect = app.getByRole("button", { name: "Connect", exact: true });
      await linkField(page).fill("not a link");
      await connect.click();
      await expect(app.getByRole("alert")).toHaveText(LINK_SHAPE);
      await linkField(page).fill(`  ${LINK} `);
      await connect.click();
      await expect.poll(() => windowCalls(page)).toContainEqual(["connect_server", { link: LINK }]);
      await expect(app.getByRole("alert")).toHaveCount(0);

      // The window leaves the page when it moves; the sheet opened again offers the servers again.
      await page.keyboard.press("Escape");
      await expect(app).toHaveCount(0);
      await settingsButton(page).click();
      await lab.click();
      await expect
        .poll(() => windowCalls(page))
        .toContainEqual(["open_server", { host: "lab.tail1234.ts.net" }]);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the palette offers the window's servers and its link field; a browser has neither",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/", beforeLoad: fakeWindow });
      const palette = page.getByRole("dialog", { name: "Palette" });
      const search = async (target: Page) => {
        await expect(settingsButton(target)).toBeVisible({ timeout: 120_000 });
        await target.keyboard.press("Control+k");
        await target.getByRole("dialog", { name: "Palette" }).getByRole("combobox").fill("server");
      };

      await search(page);
      const local = palette.getByRole("option", { name: "Use this computer's server" });
      await expect(
        palette.getByRole("option", { name: "Connect to another server…" }),
      ).toBeVisible();
      await expect(local).toBeVisible();
      await expect(
        palette.getByRole("option", { name: "Open the server on lab.tail1234.ts.net" }),
      ).toBeVisible();
      await expect(palette.getByRole("option", { name: /devbox/ })).toHaveCount(0);
      await local.click();
      await expect.poll(() => windowCalls(page)).toContainEqual(["use_this_computer", null]);

      await search(page);
      await palette.getByRole("option", { name: "Connect to another server…" }).click();
      await expect(linkField(page)).toBeFocused();

      const browser = await realApp.open({ path: "/" });
      await search(browser);
      // Only the window's server options: a tour's title can name a server ("Tour: Signing in to an MCP server").
      await expect(
        browser.getByRole("dialog", { name: "Palette" }).getByRole("option", {
          name: /^(Connect to another server|Use this computer's server|Open the server on )/,
        }),
      ).toHaveCount(0);
      await browser.keyboard.press("Escape");
      await settingsButton(browser).click();
      await expect(appSettings(browser)).toContainText("Connected to");
      await expect(linkField(browser)).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "Ctrl+Shift+N and the palette's New app window ask the window for another window; a browser has neither",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/", beforeLoad: fakeWindow });
      await expect(settingsButton(page)).toBeVisible({ timeout: 120_000 });
      const asked = async () =>
        (await windowCalls(page)).filter(([command]) => command === "new_window").length;
      await page.keyboard.press("Control+Shift+N");
      await expect.poll(asked).toBe(1);

      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Palette" });
      await palette.getByRole("combobox").fill("new app window");
      await palette.getByRole("option", { name: "New app window" }).click();
      await expect.poll(asked).toBe(2);

      await page.keyboard.press("Control+/");
      const keys = page.getByRole("dialog", { name: "Keys" });
      await expect(keys.getByText("New app window")).toBeVisible();

      // A browser keeps Ctrl+Shift+N for itself: no row in the palette, no line in the keys.
      const browser = await realApp.open({ path: "/" });
      await expect(settingsButton(browser)).toBeVisible({ timeout: 120_000 });
      await browser.keyboard.press("Control+k");
      const browserPalette = browser.getByRole("dialog", { name: "Palette" });
      await browserPalette.getByRole("combobox").fill("new app window");
      await expect(browserPalette.getByRole("option", { name: "New app window" })).toHaveCount(0);
      await browser.keyboard.press("Escape");
      await browser.keyboard.press("Control+/");
      const browserKeys = browser.getByRole("dialog", { name: "Keys" });
      await expect(browserKeys).toBeVisible();
      await expect(browserKeys.getByText("New app window")).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the first window keeps its tabs for the next start; another window keeps its own, and only in the window",
    async ({ realApp }) => {
      const key = "omp-app.ui.workspace";
      const stored = (target: Page) =>
        target.evaluate(
          (name) => ({
            local: localStorage.getItem(name),
            session: sessionStorage.getItem(name),
          }),
          key,
        );
      const tabIds = (raw: string | null): string[] => {
        const kept: { tabs?: { id: string }[] } = JSON.parse(raw ?? "{}");
        return kept.tabs?.map((tab) => tab.id) ?? [];
      };
      /** The address the desktop app gives its next window. */
      const asWindow = async (target: Page) => {
        await target.goto(`${new URL(target.url()).origin}/?window=window-2`);
        await expect(settingsButton(target)).toBeVisible({ timeout: 120_000 });
      };

      const page = await realApp.open({ path: "/", beforeLoad: fakeWindow });
      await expect.poll(async () => (await stored(page)).local).not.toBeNull();
      expect((await stored(page)).session).toBeNull();
      const firstTabs = tabIds((await stored(page)).local);

      await asWindow(page);
      await expect.poll(async () => (await stored(page)).session).not.toBeNull();
      const own = tabIds((await stored(page)).session);
      // One empty tab of its own, and the first window's tabs are as they were.
      expect(own).toHaveLength(1);
      expect(own).not.toEqual(firstTabs);
      expect(tabIds((await stored(page)).local)).toEqual(firstTabs);
      await page.reload();
      await expect(settingsButton(page)).toBeVisible({ timeout: 120_000 });
      expect(tabIds((await stored(page)).session)).toEqual(own);

      // A browser tab ignores the query: its tabs stay in localStorage.
      const browser = await realApp.open({ path: "/" });
      await asWindow(browser);
      await expect.poll(async () => (await stored(browser)).local).not.toBeNull();
      expect((await stored(browser)).session).toBeNull();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a chat that starts waiting while the window is in the background raises a notification with its title",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/", beforeLoad: fakeWindow });
      const box = await newChat(page);
      const questions = page.getByRole("dialog", { name: "Questions from omp" });
      const notices = async () =>
        (await windowCalls(page)).filter(([command]) => command === "notify");
      const ask = async () => {
        await box.fill("ask_user");
        await box.press("Enter");
        await expect(questions).toBeVisible({ timeout: 60_000 });
      };

      // In the foreground, nothing is raised.
      await ask();
      await questions.getByRole("radio", { name: "Postgres" }).click();
      await questions.getByRole("button", { name: "Submit" }).click();
      await expect(questions).toBeHidden();
      await expect(page.getByText(/^tool said: /).last()).toContainText("Postgres", {
        timeout: 60_000,
      });
      expect(await notices()).toEqual([]);

      await page.evaluate(() => {
        document.hasFocus = () => false;
      });
      await ask();
      await expect
        .poll(notices)
        .toEqual([["notify", { summary: "ask_user", body: "Waiting for you" }]]);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a turn that ends while the window is in the background raises omp's notice for it, as omp's settings say",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/", beforeLoad: fakeWindow });
      const box = await newChat(page);
      const transcript = page.getByRole("region", { name: "Transcript" });
      const notices = async () =>
        (await windowCalls(page)).filter(([command]) => command === "notify");
      const turn = async (word: string) => {
        await box.fill(`count_reply ${word}`);
        await box.press("Enter");
        await expect(transcript.getByText(new RegExp(`count-\\d+ ${word}`))).toBeVisible({
          timeout: 90_000,
        });
      };
      const settings = (line: string) =>
        appendFile(join(realApp.agentDir, "config.yml"), `\n${line}\n`);

      // In the foreground, nothing is raised.
      await turn("front");
      await page.waitForTimeout(1_500);
      expect(await notices()).toEqual([]);

      // In the background, a turn done: omp's "Complete", titled as the chat's pane.
      await page.evaluate(() => {
        document.hasFocus = () => false;
      });
      const title = (await page.locator(".dv-tab").first().innerText()).trim();
      await turn("back");
      await expect.poll(notices).toEqual([["notify", { summary: title, body: "Complete" }]]);

      // completion.notify off: a turn done raises nothing.
      await settings("completion.notify: off");
      await page.waitForTimeout(3_000);
      await turn("quiet");
      await page.waitForTimeout(2_000);
      expect(await notices()).toHaveLength(1);

      // error.notify on: a turn stopped by an error raises omp's "Stopped with error".
      await settings("error.notify: on");
      await page.waitForTimeout(3_000);
      await box.fill("provider_failure_long");
      await box.press("Enter");
      await expect.poll(notices, { timeout: 90_000 }).toEqual([
        ["notify", { summary: title, body: "Complete" }],
        ["notify", { summary: title, body: "Stopped with error" }],
      ]);
      expect(realApp.problems).toEqual([]);
    },
  );
});
