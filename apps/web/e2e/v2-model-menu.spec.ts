import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The new UI's model menu on real omp with the fake models: each provider's newest models first; a star puts a model
 * under Favorites, on every page of the server and after a reload; a hidden model folds away under Hidden, where the
 * search still finds it and Show brings it back; Recent lists the models the chat switched to, newest first.
 */

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const chip = (page: Page) => page.getByRole("button", { name: /^Model: / });
const search = (page: Page) => page.getByPlaceholder("Find a model");
const group = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
const names = async (page: Page, name: string): Promise<string[]> =>
  (await group(page, name).getByRole("option").allTextContents()).map((text) => text.trim());

async function newChat(page: Page): Promise<void> {
  await startNewChat(page);
  await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
}

/**
 * The menu builds its rows as its list scrolls (a long catalog lists hundreds): scrolling to the end builds the rest,
 * as a person scrolling down would.
 */
async function buildEveryRow(page: Page): Promise<void> {
  const list = page.locator("[cmdk-list]");
  const options = page.getByRole("option");
  for (;;) {
    const built = await options.count();
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    // More rows come a frame or two after the scroll; none for a second means every row is built.
    const grew = await expect
      .poll(() => options.count(), { timeout: 1_000 })
      .toBeGreaterThan(built)
      .then(
        () => true,
        () => false,
      );
    if (!grew) break;
  }
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
}

async function openMenu(page: Page): Promise<void> {
  await chip(page).click();
  await expect(page.getByRole("option").first()).toBeVisible({ timeout: 30_000 });
  await buildEveryRow(page);
}

realTest.describe("new UI model menu", () => {
  realTest.setTimeout(240_000);

  realTest(
    "each provider's newest models come first; a star puts a model under Favorites on every page, also after a reload",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      const other = await realApp.open({ path: "/" });
      await newChat(other);
      await openMenu(other);
      await expect(group(other, "Favorites")).toHaveCount(0);

      await openMenu(page);
      const fake = await names(page, "fake");
      const at = (name: string) => fake.findIndex((text) => text.startsWith(name));
      expect(at("Claude Fable 5")).toBeGreaterThanOrEqual(0);
      expect(at("Claude Fable 5")).toBeLessThan(at("Claude Sonnet 3.5"));
      expect(at("Claude Sonnet 3.5")).toBeLessThan(at("Claude Haiku 3"));

      // omp's catalog has models of the same name under other providers: this is the fake provider's row.
      const fable = group(page, "fake").getByRole("option", {
        name: /^Claude Fable 5\s*claude-fable-5$/,
      });
      await fable.hover();
      await group(page, "fake")
        .getByRole("button", { name: "Star Claude Fable 5", exact: true })
        .click();
      await expect(group(page, "Favorites").getByRole("option")).toHaveText([/^Claude Fable 5/]);
      // The star is the server's: the other page, menu open, shows it too.
      await expect(group(other, "Favorites").getByRole("option")).toHaveText([/^Claude Fable 5/]);
      // A click on the star leaves the caret in the search.
      await expect(search(page)).toBeFocused();

      await page.reload();
      await expect(box(page)).toBeVisible({ timeout: 60_000 });
      await newChat(page);
      await openMenu(page);
      await expect(group(page, "Favorites").getByRole("option")).toHaveText([/^Claude Fable 5/]);
      await group(page, "Favorites").getByRole("option").click();
      await expect(chip(page)).toHaveAccessibleName("Model: Claude Fable 5");

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a hidden model folds away under Hidden, the search still finds it, and Show brings it back",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await openMenu(page);
      // From the keyboard: a search that only the fake provider's Sonnet 3.5 matches highlights it, Alt+H hides it.
      await search(page).fill("fake sonnet 3.5");
      await expect(group(page, "fake").getByRole("option")).toHaveText([/^Claude Sonnet 3\.5/]);
      await page.keyboard.press("Alt+h");
      await expect(group(page, "fake")).toHaveCount(0);
      // The search still finds it, under Hidden.
      const hidden = group(page, "Hidden").getByRole("option", { name: /^Claude Sonnet 3\.5/ });
      await expect(hidden).toBeVisible();

      await search(page).fill("");
      expect(await names(page, "fake")).not.toContainEqual(
        expect.stringMatching(/^Claude Sonnet 3\.5/),
      );
      await expect(hidden).toHaveCount(0);
      await group(page, "Hidden").getByRole("option", { name: "Show 1 hidden model" }).click();
      await hidden.hover();
      await group(page, "Hidden")
        .getByRole("button", { name: "Show Claude Sonnet 3.5", exact: true })
        .click();
      await expect(group(page, "Hidden")).toHaveCount(0);
      expect(await names(page, "fake")).toContainEqual(
        expect.stringMatching(/^Claude Sonnet 3\.5/),
      );

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("Recent lists the models this chat switched to, newest first", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await newChat(page);
    await openMenu(page);
    await group(page, "fake")
      .getByRole("option", { name: /^Claude Haiku 3/ })
      .click();
    await expect(chip(page)).toHaveAccessibleName("Model: Claude Haiku 3");
    // omp stamps each switch in whole seconds, a clock the test cannot set: the next switch waits for the next second.
    await page.waitForTimeout(1_100);
    await openMenu(page);
    await group(page, "fake")
      .getByRole("option", { name: /^Claude Fable 5/ })
      .click();
    await expect(chip(page)).toHaveAccessibleName("Model: Claude Fable 5");

    await openMenu(page);
    const recent = await names(page, "Recent");
    expect(recent.slice(0, 2)).toEqual([
      expect.stringMatching(/^Claude Fable 5/),
      expect.stringMatching(/^Claude Haiku 3/),
    ]);

    expect(realApp.problems).toEqual([]);
  });
});

realTest.describe("new UI model menu, a long catalog", () => {
  realTest.setTimeout(240_000);
  // As a real provider such as OpenRouter: hundreds of models under one provider.
  realTest.use({ serverEnv: { FAKE_EXTRA_MODELS: "300" } });

  realTest(
    "opens without building every row; the arrow keys, a search and scrolling reach the models further down",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await chip(page).click();
      const options = page.getByRole("option");
      await expect(options.first()).toBeVisible({ timeout: 30_000 });
      // Building every row of hundreds held the page for seconds: the menu builds the first ones.
      expect(await options.count()).toBeLessThan(100);

      // The arrow keys go on past the rows built when it opened.
      for (let step = 0; step < 60; step += 1) await page.keyboard.press("ArrowDown");
      await expect
        .poll(() =>
          options.evaluateAll((items) =>
            items.findIndex((item) => item.getAttribute("aria-selected") === "true"),
          ),
        )
        .toBe(60);

      await search(page).fill("many model 250");
      await expect(
        group(page, "many").getByRole("option", { name: /^Many Model 250\s*many-model-250$/ }),
      ).toBeVisible();
      await search(page).fill("");

      // Scrolling to the end builds the rest: every model of the long provider, then the Hidden fold, last.
      await group(page, "many").getByRole("option").first().hover();
      await page.keyboard.press("Alt+H");
      const fold = page.getByRole("option", { name: "Show 1 hidden model" });
      const list = page.locator("[cmdk-list]");
      await expect(async () => {
        await list.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await expect(fold).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 60_000 });
      await expect(options.last()).toHaveText(/Show 1 hidden model/);
      await expect(group(page, "many").getByRole("option")).toHaveCount(299);

      expect(realApp.problems).toEqual([]);
    },
  );
});
