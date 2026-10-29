import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * The new UI's chat list and the rest of kitty's pane keys (`apps/ui`, under `/v2/`) on real omp: the list follows new
 * chats and running turns, search, pins, chats waiting for you, and swap, resize and equalize.
 */
realTest.describe("new UI chat list and pane keys", () => {
  realTest.setTimeout(240_000);
  const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });
  const boxes = (page: Page) => page.getByRole("textbox", { name: "Message" });

  async function newChat(page: Page): Promise<void> {
    await chats(page).getByRole("button", { name: "New chat" }).click();
    await expect(boxes(page).first()).toHaveAttribute("placeholder", "Message omp", {
      timeout: 120_000,
    });
  }

  realTest(
    "a new chat joins the list and shows as running while omp answers; a question puts it under Needs you",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/v2/" });
      await newChat(page);
      // omp writes a chat's file with its first reply; from then on the chat is in the list.
      await boxes(page).fill("hello");
      await boxes(page).press("Enter");
      const row = chats(page).getByRole("button", { name: /^hello/ });
      await expect(row).toHaveAccessibleName("hello, open in a pane", { timeout: 60_000 });

      await boxes(page).fill("stream_steady");
      await boxes(page).press("Enter");
      await expect(row).toHaveAccessibleName(/^hello, running/, { timeout: 60_000 });
      await expect(row).toHaveAccessibleName("hello, open in a pane", { timeout: 90_000 });

      await boxes(page).fill("ask_user");
      await boxes(page).press("Enter");
      const waiting = chats(page).getByRole("region", { name: "Needs you" });
      await expect(waiting.getByRole("button", { name: /^hello, waiting for you/ })).toBeVisible({
        timeout: 60_000,
      });
      // Answering takes it off the list of chats waiting for you.
      const questions = page.getByRole("dialog", { name: "Questions from omp" });
      await questions.getByRole("radio", { name: "Postgres" }).click();
      await questions.getByRole("button", { name: "Send answers" }).click();
      await expect(waiting).toHaveCount(0, { timeout: 60_000 });

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest.describe("with two saved chats", () => {
    realTest.use({ seedSessions: 2 });

    realTest(
      "search narrows the list, and a pinned chat comes first, also after a reload",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/v2/" });
        const search = chats(page).getByRole("searchbox", { name: "Search chats" });
        await search.fill("chat 2");
        await expect(chats(page).getByRole("button", { name: "Seeded chat 2" })).toBeVisible();
        await expect(chats(page).getByRole("button", { name: "Seeded chat 1" })).toHaveCount(0);
        await search.fill("");

        const row = chats(page).getByRole("listitem").filter({ hasText: "Seeded chat 1" });
        await row.hover();
        await row.getByRole("button", { name: "Pin" }).click();
        const pinned = chats(page).getByRole("region", { name: "Pinned" });
        await expect(pinned.getByRole("button", { name: "Seeded chat 1" })).toBeVisible();

        await page.reload();
        await expect(pinned.getByRole("button", { name: "Seeded chat 1" })).toBeVisible({
          timeout: 60_000,
        });
        await pinned.getByRole("listitem").filter({ hasText: "Seeded chat 1" }).hover();
        await pinned.getByRole("button", { name: "Unpin" }).click();
        await expect(pinned).toHaveCount(0);
        await expect(
          chats(page)
            .getByRole("region", { name: "Chats" })
            .getByRole("button", { name: "Seeded chat 1" }),
        ).toBeVisible();

        expect(realApp.problems).toEqual([]);
      },
    );
  });

  realTest("resize, equalize and swap the focused pane with kitty's keys", async ({ realApp }) => {
    const page = await realApp.open({ path: "/v2/" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await newChat(page);
    await boxes(page).first().fill("in the first pane");
    await page.keyboard.press("Control+Shift+O");
    await expect(boxes(page)).toHaveCount(2, { timeout: 60_000 });
    await expect(boxes(page).nth(1)).toBeFocused();
    const width = async (index: number) => (await boxes(page).nth(index).boundingBox())?.width ?? 0;

    const before = await width(1);
    await page.keyboard.press("Meta+Control+Shift+ArrowRight");
    await expect.poll(() => width(1)).toBeGreaterThan(before + 30);

    await page.keyboard.press("Meta+Control+Equal");
    await expect.poll(async () => Math.abs((await width(0)) - (await width(1)))).toBeLessThan(3);

    const first = await boxes(page).first().inputValue();
    expect(first).toBe("in the first pane");
    const box = page.getByRole("textbox", { name: "Message" });
    const xBefore = (await box.nth(0).boundingBox())?.x ?? 0;
    await page.keyboard.press("Control+Shift+F8");
    // The first pane's chat, with its typed text, is now on the right.
    await expect
      .poll(async () => {
        for (let index = 0; index < 2; index += 1)
          if ((await box.nth(index).inputValue()) === "in the first pane")
            return ((await box.nth(index).boundingBox())?.x ?? 0) > xBefore + 100;
        return false;
      })
      .toBe(true);

    expect(realApp.problems).toEqual([]);
  });
});
