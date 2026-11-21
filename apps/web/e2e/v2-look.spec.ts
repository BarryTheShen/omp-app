import { expect, realTest } from "./real-omp";

/** The new UI's look (`apps/ui`, under `/v2/`): the theme switch, and one pane at a time on a phone. */
realTest.describe("new UI look", () => {
  realTest(
    "switches the theme in one click, keeps it after a reload, and follows the system when asked",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(120_000);
      const page = await realApp.open({ path: "/" });
      const html = page.locator("html");
      const body = page.locator("body");
      const theme = page.getByRole("group", { name: "Theme" });

      await expect(html).toHaveAttribute("data-theme", "tern-dark");
      await expect(body).toHaveCSS("background-color", "rgb(8, 8, 10)");

      await theme.getByRole("button", { name: "Light" }).click();
      await expect(html).toHaveAttribute("data-theme", "tern-light");
      await expect(body).toHaveCSS("background-color", "rgb(239, 239, 236)");
      await page.reload();
      await expect(html).toHaveAttribute("data-theme", "tern-light");
      await expect(theme.getByRole("button", { name: "Light" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );

      await page.emulateMedia({ colorScheme: "dark" });
      await theme.getByRole("button", { name: "Match the system" }).click();
      await expect(html).toHaveAttribute("data-theme", "tern-dark");
      await page.emulateMedia({ colorScheme: "light" });
      await expect(html).toHaveAttribute("data-theme", "tern-light");

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a style applies at once, keeps after a reload, and Tern takes the app back to its own look",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(120_000);
      const page = await realApp.open({ path: "/" });
      const html = page.locator("html");
      const prose = () =>
        page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--prose"));
      await expect(html).not.toHaveAttribute("data-style", /.+/);

      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.locator('[data-tour="settings-tab-app"]').click();
      const styles = page.getByRole("group", { name: "Style" });
      await styles.getByRole("button", { name: /^Paper/ }).click();
      await expect(html).toHaveAttribute("data-style", "paper");
      expect(await prose()).toContain("Source Serif");
      await expect(styles.getByRole("button", { name: /^Paper/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      );

      await page.reload();
      await expect(html).toHaveAttribute("data-style", "paper");
      expect(await prose()).toContain("Source Serif");

      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.locator('[data-tour="settings-tab-app"]').click();
      await page
        .getByRole("group", { name: "Style" })
        .getByRole("button", { name: /^Tern/ })
        .click();
      await expect(html).not.toHaveAttribute("data-style", /.+/);
      expect(await prose()).not.toContain("Source Serif");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest.describe("on a phone", () => {
    realTest.use({ seedSessions: 1, seedLongTurn: 4 });

    realTest(
      "shows the chat list or one chat, with a way back to the list",
      async ({ realApp }, testInfo) => {
        testInfo.setTimeout(180_000);
        const page = await realApp.open({ path: "/" });
        await page.setViewportSize({ width: 390, height: 844 });
        const chats = page.getByRole("navigation", { name: "Chats" });
        const transcript = page.getByRole("region", { name: "Transcript" });

        await chats.getByRole("button", { name: "Run the long job" }).click();
        await expect(transcript.getByText("All 4 steps are done.")).toBeInViewport({
          timeout: 60_000,
        });
        await expect(chats).toBeHidden();

        await page.getByRole("button", { name: "Chats", exact: true }).click();
        await expect(chats).toBeVisible();
        await expect(transcript).toHaveCount(0);

        expect(realApp.problems).toEqual([]);
      },
    );
  });
});
