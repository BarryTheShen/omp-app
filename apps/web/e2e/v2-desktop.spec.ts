import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

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
 * records each command with its arguments and answers as the window does; the link "not a link" is refused.
 */
const fakeWindow = (target: Page) =>
  target.addInitScript(
    ({ png, servers, refusal }) => {
      const calls: [string, unknown][] = [];
      const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
      Object.assign(window, {
        windowCalls: calls,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push([command, args ?? null]);
            if (command === "read_clipboard_png") return bytes.buffer;
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
    await page
      .getByRole("navigation", { name: "Chats" })
      .getByRole("button", { name: "New chat" })
      .click();
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
      await paste("");
      await expect(page.getByRole("button", { name: "Remove Pasted image 1.png" })).toBeVisible();
      expect(await calls()).toEqual(["read_clipboard_png"]);
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
      await expect(
        browser.getByRole("dialog", { name: "Palette" }).getByRole("option", { name: /server/i }),
      ).toHaveCount(0);
      await browser.keyboard.press("Escape");
      await settingsButton(browser).click();
      await expect(appSettings(browser)).toContainText("Connected to");
      await expect(linkField(browser)).toHaveCount(0);
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
      await questions.getByRole("button", { name: "Send answers" }).click();
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
});
