import { expect, type Page } from "@playwright/test";
import { realTest } from "./real-omp";

/**
 * The lite view in the look of the app that frames it (#2844): the colours, font and text size that app puts in the
 * address paint the page, the message box, its text and Send, from the first paint; a value that is not one is
 * ignored on its own; the full app never reads them.
 */

/** A notes app's dark theme, as the issue gives it, with a font the test browser has. */
const HOST = {
  bg: "#1e1e1e",
  surface: "#2c2c2c",
  fg: "#dadada",
  muted: "#9aa0a6",
  border: "#484848",
  accent: "#3575f0",
  font: "Georgia, serif",
  fontSize: "16",
};
/** The same colours as the browser reports them. */
const SHOWN = {
  bg: "rgb(30, 30, 30)",
  surface: "rgb(44, 44, 44)",
  fg: "rgb(218, 218, 218)",
  muted: "rgb(154, 160, 166)",
  border: "rgb(72, 72, 72)",
  accent: "rgb(53, 117, 240)",
};
/** The app's own dark theme (`tern-dark`), where the host's look is not taken. */
const APP_PANEL = "rgb(15, 15, 18)";

const address = (path: string, look: Readonly<Record<string, string>>) =>
  `${path}?${new URLSearchParams({ theme: "dark", ...look })}`;
const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const style = (page: Page, selector: string, property: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);

/** The lite view at `look`, in the page `realApp.open` signed in (the launch token stays with the tab). */
async function openLite(page: Page, look: Readonly<Record<string, string>>): Promise<void> {
  await page.goto(new URL(address("/lite", look), page.url()).toString());
  await expect(box(page)).toHaveAttribute("placeholder", /^(Fake Model|Message omp)/, {
    timeout: 120_000,
  });
}

realTest.describe("new UI lite view in its host's look", () => {
  realTest(
    "the host's colours, font and text size paint the page, the message box, its text and Send",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/lite" });
      await openLite(page, HOST);
      expect(await style(page, "body", "background-color")).toBe(SHOWN.bg);
      expect(await style(page, "[data-app-root='true']", "background-color")).toBe(SHOWN.bg);
      expect(await style(page, "[data-tour='message-box']", "background-color")).toBe(
        SHOWN.surface,
      );
      expect(await style(page, "[data-tour='message-box']", "border-top-color")).toBe(SHOWN.border);
      // The header in the host's muted colour (#2845), the greeting in its text colour.
      const title = page.getByTitle("Recent chats");
      expect(await title.evaluate((element) => getComputedStyle(element).color)).toBe(SHOWN.muted);
      expect(
        await page
          .getByText("What are we working on?")
          .evaluate((element) => getComputedStyle(element).color),
      ).toBe(SHOWN.fg);
      expect(await title.evaluate((element) => getComputedStyle(element).fontFamily)).toBe(
        HOST.font,
      );
      await box(page).fill("count_reply hosted");
      const send = page.getByRole("button", { name: "Send" });
      expect(await send.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
        SHOWN.accent,
      );
      // The text you type and the conversation's text, at the host's size.
      expect(await style(page, "textarea[aria-label='Message']", "font-size")).toBe("16px");
      await send.click();
      const reply = page.getByText(/count-\d+ hosted/);
      await expect(reply).toBeVisible({ timeout: 60_000 });
      expect(await reply.evaluate((element) => getComputedStyle(element).fontSize)).toBe("16px");
      expect(await reply.evaluate((element) => getComputedStyle(element).color)).toBe(SHOWN.fg);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a value that is not one is ignored on its own, and the others still apply",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/lite" });
      await openLite(page, { bg: "red;}", fg: HOST.fg, fontSize: "40" });
      expect(await style(page, "[data-app-root='true']", "background-color")).toBe(APP_PANEL);
      expect(await style(page, ".tr-root", "font-size")).toBe("14px");
      expect(
        await page
          .getByText("What are we working on?")
          .evaluate((element) => getComputedStyle(element).color),
      ).toBe(SHOWN.fg);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("the host's background is there before the app starts", async ({ realApp, browser }) => {
    const app = new URL((await realApp.open({ path: "/lite" })).url()).origin;
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      // Only the page's own boot script runs: the app's script never loads.
      await page.route(/\/assets\/index-[^/]+\.js$/, (route) => route.abort());
      await page.goto(`${app}${address("/lite", HOST)}`);
      expect(await style(page, "body", "background-color")).toBe(SHOWN.bg);
    } finally {
      await context.close();
    }
  });

  realTest("the full app never reads the host's look", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await page.goto(new URL(address("/", HOST), page.url()).toString());
    await expect(page.locator("[data-app-root='true']")).toBeVisible({ timeout: 30_000 });
    expect(await style(page, "main[data-tour='workspace']", "background-color")).toBe(APP_PANEL);
    expect(
      await page.evaluate(() => document.documentElement.style.getPropertyValue("--panel")),
    ).toBe("");
    expect(realApp.problems).toEqual([]);
  });
});
