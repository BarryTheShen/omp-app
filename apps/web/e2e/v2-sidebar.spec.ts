import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The new UI's chat list and the rest of kitty's pane keys (`apps/ui`, under `/v2/`) on real omp: the list follows new
 * chats and running turns, search, pins, chats waiting for you, and swap, resize and equalize.
 */
realTest.describe("new UI chat list and pane keys", () => {
  realTest.setTimeout(240_000);
  const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });
  const boxes = (page: Page) => page.getByRole("textbox", { name: "Message" });

  async function newChat(page: Page): Promise<void> {
    await startNewChat(page);
    await expect(boxes(page).first()).toHaveAttribute("placeholder", "Message omp", {
      timeout: 120_000,
    });
  }

  realTest(
    "a new chat joins the list and shows as running while omp answers; a question puts it under Needs you",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      // The chat has its row from its first message on, named by it; omp writes its file with the first reply.
      await boxes(page).fill("hello");
      await boxes(page).press("Enter");
      const row = chats(page).getByRole("button", { name: /^hello/ });
      await expect(row).toHaveAccessibleName("hello, open in a window", { timeout: 60_000 });

      await boxes(page).fill("stream_steady");
      await boxes(page).press("Enter");
      await expect(row).toHaveAccessibleName(/^hello, running/, { timeout: 60_000 });
      await expect(row).toHaveAccessibleName("hello, open in a window", { timeout: 90_000 });

      await boxes(page).fill("ask_user");
      await boxes(page).press("Enter");
      const waiting = chats(page).getByRole("region", { name: "Needs you" });
      await expect(waiting.getByRole("button", { name: /^hello, waiting for you/ })).toBeVisible({
        timeout: 60_000,
      });
      // Answering takes it off the list of chats waiting for you.
      const questions = page.getByRole("dialog", { name: "Questions from omp" });
      await questions.getByRole("radio", { name: "Postgres" }).click();
      await questions.getByRole("button", { name: "Submit" }).click();
      await expect(waiting).toHaveCount(0, { timeout: 60_000 });

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest.describe("with two saved chats", () => {
    realTest.use({ seedSessions: 2 });

    realTest(
      "search narrows the list, and a pinned chat comes first, also after a reload",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
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

    realTest(
      "on a phone held sideways (874 × 402, touch) the list keeps its chats on screen beside the What's new card, and Settings is reached by scrolling",
      async ({ realApp, browser }) => {
        const context = await browser.newContext({
          viewport: { width: 874, height: 402 },
          hasTouch: true,
          isMobile: true,
        });
        const page = await realApp.open({ path: "/", context });
        await expect(page.getByRole("region", { name: "What's new" })).toBeVisible({
          timeout: 60_000,
        });
        await expect(chats(page).getByRole("button", { name: "Seeded chat 1" })).toBeInViewport({
          ratio: 1,
        });
        const settings = chats(page).getByRole("button", { name: "Settings" });
        await settings.scrollIntoViewIfNeeded();
        await expect(settings).toBeInViewport({ ratio: 1 });
        await settings.tap();
        await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
        expect(realApp.problems).toEqual([]);
        await context.close();
      },
    );

    realTest(
      "a chat picked from the list, and New chat, put the caret in the pane's message box",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
        const box = boxes(page);
        await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
        await expect(box).toBeFocused();
        // The pane shows a chat now: the next pick and New chat replace it in the same pane.
        await chats(page).getByRole("button", { name: "Seeded chat 2" }).click();
        await expect(box).toBeFocused();
        await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
        await startNewChat(page);
        await expect(box).toBeFocused();
        await page.keyboard.type("typed at once");
        await expect(box).toHaveValue("typed at once");

        expect(realApp.problems).toEqual([]);
      },
    );

    realTest(
      "a new chat keeps its row while its first reply runs: the row opens it, and stays when the reply is done",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
        await newChat(page);
        await boxes(page).fill("long first reply stream_steady");
        await boxes(page).press("Enter");
        const transcript = page.getByRole("region", { name: "Transcript" });
        await expect(transcript).toContainText("Steady line 0", { timeout: 90_000 });
        // omp writes the chat's file only once this reply is done; the chat's row is in the list before that.
        await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
        const row = chats(page).getByRole("button", { name: /^long first reply stream_steady/ });
        await expect(row).toHaveAccessibleName("long first reply stream_steady, running", {
          timeout: 10_000,
        });
        // Without a file there is nothing to pin, rename or delete yet.
        const item = chats(page)
          .getByRole("listitem")
          .filter({ hasText: "long first reply stream_steady" });
        await expect(item.getByRole("button", { name: "More" })).toHaveCount(0);

        await row.click();
        await expect(transcript).toContainText("long first reply stream_steady");
        await expect(transcript).toContainText(/Steady line [1-9]/, { timeout: 30_000 });
        // The reply ends and omp writes the file: the same row stays, now with its menu.
        await expect(row).toHaveAccessibleName("long first reply stream_steady, open in a window", {
          timeout: 120_000,
        });
        await expect(item.getByRole("button", { name: "More" })).toHaveCount(1);

        expect(realApp.problems).toEqual([]);
      },
    );
  });

  realTest("resize, equalize and swap the focused pane with kitty's keys", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await newChat(page);
    await boxes(page).first().fill("in the first pane");
    await page.keyboard.press("Control+Shift+O");
    // The split is a blank window with the caret on its New chat.
    await page.keyboard.press("Enter");
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

/** omp names a chat, as it does on its terminal (#2798): the list shows that name in place of the first message. */
realTest.describe("new UI chat list: the chat's title from omp", () => {
  realTest.setTimeout(240_000);
  realTest.use({ serverEnv: { PI_NO_TITLE: "" } });

  realTest(
    "a new chat takes the title omp names it with, in place of its first message (#2798)",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      const box = page.getByRole("textbox", { name: "Message" }).first();
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      // A task: omp leaves a greeting or an acknowledgement unnamed (`isLowSignalTitleInput`).
      await box.fill("rename the export button in the toolbar");
      await box.press("Enter");
      const chats = page.getByRole("navigation", { name: "Chats" });
      await expect(chats.getByRole("button", { name: /Fake chat title marker/ })).toBeVisible({
        timeout: 90_000,
      });
      await expect(chats.getByRole("button", { name: /^rename the export/ })).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );
});

/** An old chat, from before omp named the app's chats, is named from its conversation once it opens (#2798). */
realTest.describe("new UI chat list: an old chat's title from omp", () => {
  realTest.setTimeout(240_000);
  realTest.use({ serverEnv: { PI_NO_TITLE: "" }, seedSessions: 1 });

  realTest(
    "an old chat with no title takes one from its conversation once it opens (#2798)",
    async ({ realApp }) => {
      // omp names it with its title model (the `tiny` role, as `/rename` does): here the fake model.
      await appendFile(
        join(realApp.agentDir, "config.yml"),
        "\nmodelRoles:\n  tiny: fake/fake-model\n",
      );
      const page = await realApp.open({ path: "/" });
      const chats = page.getByRole("navigation", { name: "Chats" });
      const old = chats.getByRole("button", { name: /^Seeded chat 1/ });
      await expect(old).toBeVisible({ timeout: 120_000 });
      await old.click();
      await expect(chats.getByRole("button", { name: /Fake old chat title/ })).toBeVisible({
        timeout: 90_000,
      });
      await expect(old).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );
});

/** The chat list resizes and hides on a desktop (#2805), and keeps both in this browser. */
realTest.describe("new UI chat list: resize and hide", () => {
  realTest.setTimeout(240_000);

  realTest(
    "the list's edge resizes it and the width stays after a reload; its button, Show and Ctrl+B hide and show it (#2805)",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      const list = page.getByRole("navigation", { name: "Chats" });
      const edge = list.getByRole("separator", { name: "Resize the chat list" });
      await expect(edge).toBeVisible({ timeout: 120_000 });
      const width = async (): Promise<number> => Math.round((await list.boundingBox())?.width ?? 0);
      const before = await width();

      // A drag of the edge, 100 px to the right.
      const box = await edge.boundingBox();
      if (box === null) throw new Error("no edge");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
      await expect.poll(width).toBe(before + 100);
      await page.reload();
      await expect(edge).toBeVisible({ timeout: 60_000 });
      await expect.poll(width).toBe(before + 100);

      // Hidden by its button, back by Show before the tabs; Ctrl+B both ways.
      await list.getByRole("button", { name: "Hide the chat list" }).click();
      await expect(list).toBeHidden();
      await page.getByRole("button", { name: "Show the chat list" }).click();
      await expect(list).toBeVisible();
      await page.keyboard.press("Control+b");
      await expect(list).toBeHidden();
      await page.keyboard.press("Control+b");
      await expect(list).toBeVisible();

      // A double click gives the list its own width again.
      await edge.dblclick();
      await expect.poll(width).toBe(before);
      expect(realApp.problems).toEqual([]);
    },
  );
});
