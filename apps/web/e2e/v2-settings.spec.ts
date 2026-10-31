import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * The new UI's settings (`apps/ui`, under `/v2/`) on real omp: omp's own settings by tab, search, each kind of control
 * written to omp's settings file, a change marked with its Reset, kept when the server restarts; one folder's own.
 */
realTest.describe("new UI settings", () => {
  realTest.setTimeout(240_000);
  const sheet = (page: Page) => page.getByRole("dialog", { name: "Settings" });
  const nav = (page: Page) => sheet(page).getByRole("navigation", { name: "Settings sections" });
  const tab = (page: Page, label: string) =>
    nav(page).getByRole("button", { name: new RegExp(`^${label}`) });
  /** How many settings a tab has changed (its name says "Model, 2 changed"); the test harness's omp file sets some. */
  const changed = async (page: Page, label: string): Promise<number> =>
    Number(
      /, (\d+) changed$/.exec((await tab(page, label).getAttribute("aria-label")) ?? "")?.[1] ?? 0,
    );

  async function openSettings(page: Page): Promise<void> {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(sheet(page)).toBeVisible();
  }

  realTest(
    "open by the gear, Ctrl+, and the palette; search finds a setting by its words",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await openSettings(page);
      // The app's own tab first, then omp's tabs in omp's order, each page with omp's lead sentence.
      await expect(nav(page).getByRole("button")).toHaveText([
        "App",
        /^Appearance/,
        /^Model/,
        /^Interaction/,
        /^Context/,
        /^Memory/,
        /^Files/,
        /^Shell/,
        /^Tools/,
        /^Tasks/,
        /^Providers/,
      ]);
      const app = sheet(page).getByRole("region", { name: "App settings" });
      await expect(app.getByRole("group", { name: "Theme" })).toBeVisible();
      await expect(app.getByRole("region", { name: "Message box" })).toBeVisible();
      await tab(page, "Appearance").click();
      await expect(sheet(page)).toContainText(
        "Theme, composer, status line and how the transcript renders.",
      );
      await page.keyboard.press("Escape");
      await expect(sheet(page)).toHaveCount(0);

      await page.keyboard.press("Control+Comma");
      await expect(sheet(page)).toBeVisible();
      const search = sheet(page).getByRole("searchbox", { name: "Search settings" });
      await search.fill("per-session goal");
      const results = sheet(page).getByRole("region", { name: "Search results" });
      await expect(results.getByRole("switch", { name: "Goal Mode" })).toBeVisible();
      await expect(results.locator("mark")).toHaveText(["per-session goal"]);
      await search.fill("no such setting anywhere");
      await expect(sheet(page)).toContainText("No settings match “no such setting anywhere”.");
      await page.keyboard.press("Control+Comma");
      await expect(sheet(page)).toHaveCount(0);

      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Palette" });
      await palette.getByRole("combobox").fill("settings");
      await palette.getByRole("option", { name: /^Open the settings/ }).click();
      await expect(sheet(page)).toBeVisible();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a switch, a choice, a menu and a number are written to omp's file, marked with Reset, and kept after a restart",
    async ({ realApp }) => {
      let page = await realApp.open({ path: "/" });
      await openSettings(page);
      await tab(page, "Tasks").click();
      const goal = sheet(page).getByRole("switch", { name: "Goal Mode" });
      await expect(goal).toBeChecked();
      await goal.click();
      await expect(goal).not.toBeChecked();
      await expect(
        sheet(page).getByRole("img", { name: "Changed from default: on" }),
      ).toBeVisible();
      await expect(tab(page, "Tasks")).toHaveAccessibleName("Tasks, 1 changed");

      await tab(page, "Model").click();
      const before = await changed(page, "Model");
      await sheet(page)
        .getByRole("group", { name: "Text Verbosity" })
        .getByRole("button", { name: "High" })
        .click();
      await sheet(page).getByRole("combobox", { name: "Personality" }).click();
      await page.getByRole("option", { name: "Pragmatic" }).click();
      const lifetime = sheet(page).getByRole("textbox", { name: "Image URL Lifetime (hours)" });
      await expect(lifetime).toHaveValue("72");
      await lifetime.fill("48");
      await lifetime.press("Enter");
      await expect(tab(page, "Model")).toHaveAccessibleName(`Model, ${before + 3} changed`);
      await expect(
        sheet(page).getByRole("img", { name: "Changed from default: 72" }),
      ).toBeVisible();

      const file = join(realApp.agentDir, "config.yml");
      await expect.poll(async () => readFile(file, "utf8")).toMatch(/goal:\n {2}enabled: false/);
      const written = await readFile(file, "utf8");
      expect(written).toContain("textVerbosity: high");
      expect(written).toContain("personality: pragmatic");
      expect(written).toMatch(/ttlHours: 48/);

      // The page goes first: a page left open would try its old link while the server is down (an expected error).
      await page.close();
      await realApp.restartServer();
      page = await realApp.open({ path: "/" });
      await openSettings(page);
      await tab(page, "Model").click();
      await expect(
        sheet(page)
          .getByRole("group", { name: "Text Verbosity" })
          .getByRole("button", { name: "High" }),
      ).toHaveAttribute("aria-pressed", "true");
      // Its text also holds the menu's chevron (hidden from screen readers).
      await expect(sheet(page).getByRole("combobox", { name: "Personality" })).toContainText(
        "Pragmatic",
      );
      await expect(
        sheet(page).getByRole("textbox", { name: "Image URL Lifetime (hours)" }),
      ).toHaveValue("48");
      await tab(page, "Tasks").click();
      await expect(sheet(page).getByRole("switch", { name: "Goal Mode" })).not.toBeChecked();

      // Reset takes the line out of the file: omp's default is back.
      await sheet(page).getByRole("button", { name: "Reset Goal Mode" }).click();
      await expect(sheet(page).getByRole("switch", { name: "Goal Mode" })).toBeChecked();
      await expect(sheet(page).getByRole("img", { name: "Changed from default: on" })).toHaveCount(
        0,
      );
      await expect(tab(page, "Tasks")).toHaveAccessibleName("Tasks");
      await expect.poll(async () => readFile(file, "utf8")).not.toContain("enabled: false");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "this folder's settings go to its own file and leave every folder's alone",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await openSettings(page);
      await sheet(page)
        .getByRole("group", { name: "Whose settings" })
        .getByRole("button", { name: "This folder" })
        .click();
      await tab(page, "Tasks").click();
      const goal = sheet(page).getByRole("switch", { name: "Goal Mode" });
      await expect(goal).toBeChecked();
      await goal.click();
      await expect(goal).not.toBeChecked();
      await expect(tab(page, "Tasks")).toHaveAccessibleName("Tasks, 1 changed");
      await expect
        .poll(async () =>
          readFile(join(realApp.folder, ".omp", "config.yml"), "utf8").catch(() => ""),
        )
        .toMatch(/goal:\n {2}enabled: false/);
      const everyFolder = await readFile(join(realApp.agentDir, "config.yml"), "utf8").catch(
        () => "",
      );
      expect(everyFolder).not.toContain("enabled: false");

      await sheet(page)
        .getByRole("group", { name: "Whose settings" })
        .getByRole("button", { name: "Every folder" })
        .click();
      await expect(sheet(page).getByRole("switch", { name: "Goal Mode" })).toBeChecked();
      await expect(tab(page, "Tasks")).toHaveAccessibleName("Tasks");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("provider sign-in goes through the open chat", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await openSettings(page);
    await tab(page, "Providers").click();
    const signIn = sheet(page).getByRole("region", { name: "Sign-in" });
    await expect(signIn).toContainText("Open a chat to sign in: omp signs in inside a chat.");
    await page.keyboard.press("Escape");

    await page
      .getByRole("navigation", { name: "Chats" })
      .getByRole("button", { name: "New chat" })
      .click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "placeholder",
      "Message omp",
      { timeout: 120_000 },
    );
    await openSettings(page);
    await tab(page, "Providers").click();
    // The test environment gives omp an Anthropic key: signed in; the others are one choice away.
    await expect(signIn.getByRole("listitem", { name: "Anthropic" })).toContainText("Signed in", {
      timeout: 30_000,
    });
    const signInButton = signIn.getByRole("button", { name: "Sign in", exact: true });
    await expect(signInButton).toBeDisabled();
    await signIn.getByRole("combobox", { name: "Provider to sign in to" }).click();
    // Every provider's name fits its row, the longest among them too: none runs past the row's edge.
    await expect(page.getByRole("option", { name: /Codex Subscription/ })).toBeVisible();
    const cut = await page
      .getByRole("option")
      .evaluateAll((options) =>
        options
          .filter((option) => option.scrollWidth > option.clientWidth + 1)
          .map((option) => option.textContent),
      );
    expect(cut).toEqual([]);
    await page.getByRole("option").first().click();
    await expect(signInButton).toBeEnabled();
    expect(realApp.problems).toEqual([]);
  });
});
