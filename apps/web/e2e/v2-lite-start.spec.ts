import { type Browser, expect, type Page } from "@playwright/test";
import { type RealApp, realTest, startNewChat } from "./real-omp";

/**
 * The lite view's empty chat as the framing app's assistant (#2845): none of a terminal's folder and keys, and the
 * greeting, suggestions and placeholder that app puts in the address (a suggestion picked is sent); the header in its
 * muted colour and, with the greeting, at its text size. Without them the app's own greeting and placeholder; the full
 * app is unchanged.
 */

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const suggestions = (page: Page) => page.getByRole("list", { name: "Suggestions" });
/** What a new chat's first screen shows of a terminal: the keys of the message box ("/ commands", its key in a kbd). */
const keys = (page: Page) => page.getByText(/^\/\s*commands$/);
/** The folder line of a new chat's first screen, as the full app prints it: the folder's last two parts. */
const folderLine = (page: Page, folder: string) => {
  const parts = folder.split("/").filter((part) => part !== "");
  return page.getByText(parts.length <= 2 ? folder : `…/${parts.slice(-2).join("/")}`, {
    exact: true,
  });
};

/** The lite view at `query` in a computer's 400 px panel. */
async function openLite(browser: Browser, realApp: RealApp, query: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 400, height: 800 } });
  const page = await realApp.open({ path: "/lite", context });
  await page.goto(new URL(`/lite${query}`, page.url()).toString());
  await expect(page.locator("[data-app-root='true']")).toBeVisible({ timeout: 30_000 });
  return page;
}

realTest.describe("new UI lite view's start", () => {
  realTest(
    "the framing app's greeting, suggestions and placeholder; a suggestion picked is sent",
    async ({ realApp, browser }) => {
      const page = await openLite(
        browser,
        realApp,
        "?greeting=How%20can%20I%20help%3F&suggest=Summarize%20this%20page|Find%20related%20notes&placeholder=Ask%20your%20notes",
      );
      await expect(box(page)).toHaveAttribute("placeholder", "Ask your notes", {
        timeout: 120_000,
      });
      await expect(page.getByText("How can I help?")).toBeVisible();
      await expect(suggestions(page).getByRole("button")).toHaveText([
        "Summarize this page",
        "Find related notes",
      ]);
      await expect(keys(page)).toHaveCount(0);
      await expect(folderLine(page, realApp.folder)).toHaveCount(0);

      await suggestions(page).getByRole("button", { name: "Find related notes" }).click();
      await expect(
        page.getByRole("region", { name: "Transcript" }).getByText("Find related notes"),
      ).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText("How can I help?")).toHaveCount(0);
      await expect(box(page)).toHaveValue("");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "without choices: the app's greeting and placeholder, and no folder or keys",
    async ({ realApp, browser }) => {
      const page = await openLite(browser, realApp, "");
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await expect(page.getByText("What are we working on?")).toBeVisible();
      await expect(suggestions(page)).toHaveCount(0);
      await expect(keys(page)).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the header in the framing app's muted colour, and it and the greeting at its text size",
    async ({ realApp, browser }) => {
      const page = await openLite(browser, realApp, "?muted=%239aa0a6&fontSize=16");
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      const title = page.getByTitle("Recent chats");
      const looks = await title.evaluate((element) => {
        const style = getComputedStyle(element);
        return { color: style.color, size: style.fontSize };
      });
      expect(looks).toEqual({ color: "rgb(154, 160, 166)", size: "16px" });
      const greeting = Number.parseFloat(
        await page
          .getByText("What are we working on?")
          .evaluate((element) => getComputedStyle(element).fontSize),
      );
      expect(greeting).toBeCloseTo((16 * 8) / 7, 1);
      const icon = await page.getByTitle("New chat").locator("svg").boundingBox();
      expect(icon?.width ?? 0).toBeCloseTo((16 * 8) / 7, 0);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("the full app keeps its first screen and reads none of these", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await page.goto(
      new URL("/?greeting=Hello&placeholder=Ask%20your%20notes", page.url()).toString(),
    );
    await startNewChat(page);
    await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
    await expect(page.getByText("What are we working on?")).toBeVisible();
    await expect(keys(page)).toBeVisible();
    await expect(folderLine(page, realApp.folder)).toBeVisible();
    await expect(page.getByText("Hello", { exact: true })).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  });
});
