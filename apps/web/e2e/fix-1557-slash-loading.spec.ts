import type { Locator, Page } from "@playwright/test";
import { expect, realTest, startChat } from "./real-omp";

/** What the slash list says once a search has answered with no commands. */
const NO_MATCH = "No matching commands.";

/** What the page records while the list is up: how often the no-match text showed before any command did. */
interface SlashWatch {
  noMatchBeforeOptions: number;
  optionsSeen: boolean;
}

function commandList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Slash commands" });
}

realTest(
  "typing / in a new chat never says 'No matching commands.' before omp's commands appear",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);

    // Watch every change to the page from before the first character is typed. Each time the list shows the no-match
    // text while it has no command option, that is a claim made before any answer, and it is counted.
    await page.evaluate((noMatch) => {
      const watch: SlashWatch = { noMatchBeforeOptions: 0, optionsSeen: false };
      Object.assign(window, { __slashWatch: watch });
      const check = () => {
        const list = document.querySelector('[aria-label="Slash commands"]');
        if (list === null) return;
        if (list.querySelectorAll('[role="option"]').length > 0) {
          watch.optionsSeen = true;
        } else if (!watch.optionsSeen && (list.textContent ?? "").includes(noMatch)) {
          watch.noMatchBeforeOptions += 1;
        }
      };
      new MutationObserver(check).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }, NO_MATCH);

    await composer.fill("/s");
    await expect(commandList(page).getByRole("option").first()).toBeVisible({ timeout: 60_000 });

    const watch = await page.evaluate(() =>
      Object.assign({}, (window as Window & { __slashWatch?: SlashWatch }).__slashWatch),
    );
    expect(watch.optionsSeen).toBe(true);
    expect(watch.noMatchBeforeOptions).toBe(0);
  },
);
