import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

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
    await page
      .getByRole("navigation", { name: "Chats" })
      .getByRole("button", { name: "New chat" })
      .click();
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
    await expect(box(page)).toHaveCount(2, { timeout: 60_000 });

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
        .getByRole("button", { name: "Seeded chat 2, open in a pane" }),
    ).toBeVisible({ timeout: 60_000 });

    await page.keyboard.press("Control+k");
    await search(page).fill("theme: light");
    await search(page).press("Enter");
    await expect(
      page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light" }),
    ).toHaveAttribute("aria-pressed", "true");

    expect(realApp.problems).toEqual([]);
  });

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
    await expect(sheet.getByRole("region", { name: "Panes" })).toContainText(
      "Split right with a new chat",
    );
    await expect(sheet.getByRole("region", { name: "Panes" })).toContainText("Ctrl+Shift+O");
    await expect(sheet.getByRole("region", { name: "Message box" })).toContainText("Shift+Tab");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    expect(realApp.problems).toEqual([]);
  });
});
