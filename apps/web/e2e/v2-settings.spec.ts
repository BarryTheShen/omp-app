import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";
import { drawnAfterClick } from "./timing";

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
    "Settings, omp's settings and the dashboard load in the background once the app is up, and their first open draws at once",
    async ({ realApp }) => {
      const fetched: string[] = [];
      const page = await realApp.open({
        path: "/",
        beforeLoad: async (opened) => {
          opened.on("request", (request) => fetched.push(request.url()));
        },
      });
      await expect(page.locator("[data-app-root='true']")).toBeVisible({ timeout: 30_000 });
      for (const chunk of [
        /\/SettingsPage-[^/]+\.js$/,
        /\/omp-settings-[^/]+\.js$/,
        /\/DashboardPage-[^/]+\.js$/,
      ])
        await expect
          .poll(() => fetched.some((url) => chunk.test(url)), { timeout: 15_000 })
          .toBe(true);
      await expect(sheet(page)).toHaveCount(0);
      // A page whose first draw waits for its code shows no sooner than 300 ms after the click (React holds content
      // that was loading that long after its empty fallback); drawn at once, it takes about 50 ms.
      const settingsDrawn = drawnAfterClick(page, 'nav[aria-label="Settings sections"] button');
      await openSettings(page);
      expect(await settingsDrawn).toBeLessThan(250);
      await page.keyboard.press("Escape");
      await expect(sheet(page)).toBeHidden();
      const dashboardDrawn = drawnAfterClick(page, '[data-tour="dashboard"]');
      await page.getByRole("button", { name: "Dashboard", exact: true }).click();
      expect(await dashboardDrawn).toBeLessThan(250);
      await expect(
        page.locator('[data-tour="dashboard"]').getByRole("heading", { name: "Dashboard" }),
      ).toBeVisible();
      expect(realApp.problems).toEqual([]);
    },
  );

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
    "a section opens at its top, wherever the one before was scrolled to",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await openSettings(page);
      const scrolled = () =>
        page.evaluate(() => {
          const scroller = [...document.querySelectorAll<HTMLElement>('[role="dialog"] *')].find(
            (each) =>
              /(auto|scroll)/.test(getComputedStyle(each).overflowY) &&
              each.scrollHeight > each.clientHeight + 1 &&
              each.clientHeight > 300,
          );
          return scroller?.scrollTop ?? -1;
        });
      const text = sheet(page).getByText("How this app looks");
      const at = await text.boundingBox();
      if (at === null) throw new Error("the App page is not drawn");
      await page.mouse.move(at.x + 20, at.y + at.height / 2);
      await page.mouse.wheel(0, 600);
      await expect.poll(scrolled).toBeGreaterThan(0);
      await tab(page, "Model").click();
      await expect(sheet(page).getByRole("heading", { name: "Model", exact: true })).toBeVisible();
      await expect.poll(scrolled).toBe(0);
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
    "a switch moves when it is clicked, before its write is done, and goes back with a note when the write fails",
    async ({ realApp }) => {
      // The page's writes of Goal Mode are held on their way to the server (`hold`), or sent with a revision the server
      // does not have (`refuse`), so that it refuses them.
      const writes = { hold: false, refuse: false };
      const page = await realApp.open({
        path: "/",
        beforeLoad: (opened) =>
          opened.routeWebSocket(
            () => true,
            (webSocket) => {
              const server = webSocket.connectToServer();
              webSocket.onMessage((message) => {
                const goalWrite =
                  typeof message === "string" &&
                  message.includes('"port":"A1.configStore"') &&
                  message.includes('"method":"write"') &&
                  message.includes('"key":"goal.enabled"');
                if (goalWrite && writes.refuse)
                  server.send(
                    message.replace(
                      /"expectedRevision":(?:null|"[^"]*")/,
                      '"expectedRevision":"not-the-file"',
                    ),
                  );
                else if (goalWrite && writes.hold) setTimeout(() => server.send(message), 3_000);
                else server.send(message);
              });
              server.onMessage((message) => webSocket.send(message));
            },
          ),
      });
      await openSettings(page);
      await tab(page, "Tasks").click();
      const goal = sheet(page).getByRole("switch", { name: "Goal Mode" });
      await expect(goal).toBeChecked();
      const file = join(realApp.agentDir, "config.yml");

      // The switch moves at once; the server gets the write 3 s later, and keeps it.
      writes.hold = true;
      await goal.click();
      await expect(goal).not.toBeChecked({ timeout: 1_000 });
      await expect.poll(async () => readFile(file, "utf8")).toMatch(/goal:\n {2}enabled: false/);
      await expect(goal).not.toBeChecked();
      writes.hold = false;

      // A write the server refuses puts the switch back, and the row says so.
      writes.refuse = true;
      await goal.click();
      await expect(sheet(page).getByRole("alert")).toContainText("Could not save it");
      await expect(goal).not.toBeChecked();
      expect(await readFile(file, "utf8")).toMatch(/goal:\n {2}enabled: false/);
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

    await startNewChat(page);
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
