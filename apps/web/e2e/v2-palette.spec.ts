import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The new UI's palette (Ctrl+K) and keys sheet (Ctrl+/) (`apps/ui`, under `/v2/`) on real omp: the app's commands and
 * omp's, files into the message box, chats, models and themes.
 */
realTest.describe("new UI palette", () => {
  realTest.setTimeout(240_000);
  realTest.use({
    seedSessions: 2,
    seedWorkspace: { files: { "src/parser.ts": "export const parse = 1;\n" }, gitRepo: true },
  });
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const palette = (page: Page) => page.getByRole("dialog", { name: "Palette" });
  const search = (page: Page) =>
    palette(page).getByRole("combobox", { name: "Search the palette" });

  async function newChat(page: Page): Promise<void> {
    await startNewChat(page);
    await expect(box(page).first()).toHaveAttribute("placeholder", "Message omp", {
      timeout: 120_000,
    });
  }

  realTest("runs the app's commands, opens chats and switches the theme", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await newChat(page);

    await box(page).press("Control+k");
    await expect(palette(page)).toBeVisible();
    await search(page).fill("split right");
    await search(page).press("Enter");
    await expect(palette(page)).toBeHidden();
    // The split is a blank window (#2791), which the chat opened next fills.
    const blank = page.locator("[data-tab]:not([data-hidden]) [data-blank-window]");
    await expect(blank).toHaveCount(1, { timeout: 30_000 });
    await expect(box(page)).toHaveCount(1);

    await page.keyboard.press("Control+k");
    await palette(page)
      .getByRole("radio", { name: "Chats" })
      .or(palette(page).getByRole("button", { name: "Chats" }))
      .first()
      .click();
    await search(page).fill("chat 2");
    await search(page).press("Enter");
    await expect(
      page
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: "Seeded chat 2, open in a window" }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(blank).toHaveCount(0);
    await expect(box(page)).toHaveCount(2, { timeout: 60_000 });

    await page.keyboard.press("Control+k");
    await search(page).fill("Theme: Tern Light");
    await search(page).press("Enter");
    await expect(
      page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light" }),
    ).toHaveAttribute("aria-pressed", "true");

    expect(realApp.problems).toEqual([]);
  });

  realTest(
    "before anything is typed it leaves out themes, tours and omp's commands; a search shows its first 30 matches",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await box(page).press("Control+k");
      await expect(palette(page)).toBeVisible();
      await expect(palette(page).getByRole("option", { name: /^New chat/ })).toBeVisible();
      await expect(palette(page).getByRole("option", { name: /^Tour: / })).toHaveCount(0);
      await expect(palette(page).getByRole("option", { name: /^Theme: / })).toHaveCount(0);
      await expect(
        palette(page).getByText("Type to find a theme, a tour or one of omp's commands"),
      ).toBeVisible();

      // Every update brought a tour, so far more than 30 match.
      await search(page).fill("Tour:");
      await expect(palette(page).getByRole("option", { name: /^Tour: / })).toHaveCount(30);
      await expect(palette(page).getByText(/^\d+ more matches: keep typing$/)).toBeVisible();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "puts a file or one of omp's commands into the box, and switches the model",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);

      await box(page).press("Control+k");
      await search(page).fill("pars");
      await expect(palette(page).getByRole("option", { name: "src/parser.ts" })).toBeVisible({
        timeout: 30_000,
      });
      await palette(page).getByRole("option", { name: "src/parser.ts" }).click();
      await expect(box(page)).toHaveValue("@src/parser.ts ");

      // The box puts the caret after what came in on the next frame; a select-all before that frame is collapsed by it.
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
      await box(page).fill("");
      await page.keyboard.press("Control+k");
      await search(page).fill("/compact");
      await expect(palette(page).getByRole("option", { name: /^\/compact/ })).toBeVisible({
        timeout: 30_000,
      });
      await search(page).press("Enter");
      await expect(box(page)).toHaveValue("/compact ");

      await page.keyboard.press("Control+k");
      await search(page).fill("Claude Fable 5");
      // The fake provider's copy; other providers list the same name.
      await palette(page)
        .getByRole("option", { name: /^Claude Fable 5.*fake\// })
        .first()
        .click();
      await expect(page.getByRole("button", { name: "Model: Claude Fable 5" })).toBeVisible({
        timeout: 30_000,
      });

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("Ctrl+/ shows every key", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await page.keyboard.press("Control+Slash");
    const sheet = page.getByRole("dialog", { name: "Keys" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("region", { name: "Windows" })).toContainText(
      "Split right into a blank window",
    );
    await expect(sheet.getByRole("region", { name: "Windows" })).toContainText("Ctrl+Shift+O");
    await expect(sheet.getByRole("region", { name: "Message box" })).toContainText("Shift+Tab");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    expect(realApp.problems).toEqual([]);
  });
});
