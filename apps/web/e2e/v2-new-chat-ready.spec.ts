import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * A new chat always ready (#2760) in the new UI on real omp, as the installed app runs (`OMP_APP_NEW_CHATS_READY=1`):
 * new chat after new chat opens and answers, and the chats started ahead never show in the list of chats.
 */
realTest.use({ serverEnv: { OMP_APP_NEW_CHATS_READY: "1" } });

realTest.describe("a new chat always ready", () => {
  realTest.setTimeout(240_000);
  const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });

  /** Opens a new chat and returns how long it took to take text, in ms. */
  async function newChat(page: Page): Promise<number> {
    const started = Date.now();
    await chats(page).getByRole("button", { name: "New chat" }).click();
    await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
    return Date.now() - started;
  }

  async function turn(page: Page, word: string): Promise<void> {
    await box(page).fill(`count_reply ${word}`);
    await box(page).press("Enter");
    await expect(transcript(page).getByText(new RegExp(`count-\\d+ ${word}`))).toBeVisible({
      timeout: 90_000,
    });
  }

  realTest(
    "new chat after new chat opens and answers; no chat started ahead shows in the list",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      // The page asks for a new chat ready in its folder as it shows; a person looks at the page before clicking.
      await page.waitForTimeout(8_000);
      const first = await newChat(page);
      await turn(page, "first");
      // The next one has been started ahead meanwhile.
      await page.waitForTimeout(5_000);
      const second = await newChat(page);
      await turn(page, "second");
      const third = await newChat(page);
      console.log(
        `new chat ready after: first ${first} ms, second ${second} ms, third ${third} ms`,
      );

      // The list holds the two chats with a reply; the one open now and the one started behind it have none yet.
      await expect(
        chats(page).getByRole("button", { name: /count_reply (first|second)/ }),
      ).toHaveCount(2, {
        timeout: 30_000,
      });
      await expect(chats(page).getByRole("button", { name: /^New chat\b/ })).toHaveCount(1);
      expect(realApp.problems).toEqual([]);
    },
  );
});
