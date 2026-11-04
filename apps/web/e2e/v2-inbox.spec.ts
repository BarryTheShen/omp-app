import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The new UI's attention inbox (`apps/ui/src/inbox`), Tern's, on real omp: the bell in the sidebar counts the chats that
 * need a look. A turn that ends while you are in another pane, or while the page is in the background, is kept until
 * you look at its chat, with omp's reason when it failed; a turn that ends in the pane you are in is not. A chat waiting
 * for you shows until it is answered, and Clear does not take it away.
 */
realTest.describe("new UI inbox", () => {
  realTest.setTimeout(240_000);
  const boxes = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const bell = (page: Page) => page.getByRole("button", { name: /^Inbox/ });
  const inbox = (page: Page) => page.getByRole("dialog", { name: "Inbox" });
  const rows = (page: Page) =>
    inbox(page).getByRole("list", { name: "Chats that need a look" }).getByRole("button");
  const newChat = async (page: Page) => {
    await startNewChat(page);
    await expect(boxes(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(boxes(page).first()).toHaveAttribute("placeholder", "Message omp", {
      timeout: 120_000,
    });
  };
  const send = async (page: Page, index: number, text: string) => {
    await boxes(page).nth(index).fill(text);
    await boxes(page).nth(index).press("Enter");
  };

  realTest(
    "a turn that ends while you are in another pane rings the bell; going back clears it; one in your pane does not",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await expect(bell(page)).toHaveAccessibleName("Inbox");

      // A reply of about ten seconds in the first pane; meanwhile a second pane takes the focus.
      await send(page, 0, "stream_long_code");
      await expect(page.getByText("Here is the long streamed block:")).toBeVisible({
        timeout: 60_000,
      });
      await page.keyboard.press("Control+Shift+O");
      // The split is a blank window with the caret on its New chat.
      await page.keyboard.press("Enter");
      await expect(boxes(page)).toHaveCount(2, { timeout: 60_000 });
      await expect(boxes(page).nth(1)).toBeFocused();

      await expect(bell(page)).toHaveAccessibleName("Inbox: 1", { timeout: 90_000 });
      await bell(page).click();
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page).first()).toContainText("stream_long_code");
      await expect(rows(page).first()).toContainText("Done");

      // The row goes to the first pane's chat, which clears it.
      await rows(page).first().click();
      await expect(inbox(page)).toBeHidden();
      await expect(boxes(page).first()).toBeFocused();
      await expect(bell(page)).toHaveAccessibleName("Inbox");

      // A turn that ends in the pane you are in is seen already.
      await send(page, 0, "hello");
      await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(boxes(page).first()).toBeFocused();
      await page.waitForTimeout(1_000);
      await expect(bell(page)).toHaveAccessibleName("Inbox");

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a turn that fails while the page is in the background shows omp's reason, and goes when the page comes back",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      // The page is in the background, as the desktop spec makes it: it has no focus.
      await page.evaluate(() => {
        document.hasFocus = () => false;
      });
      await send(page, 0, "provider_failure_long");
      await expect(bell(page)).toHaveAccessibleName("Inbox: 1", { timeout: 90_000 });
      await bell(page).click();
      await expect(rows(page).first()).toContainText("provider_failure_long");
      await expect(rows(page).first()).toContainText("Stopped with error");
      await expect(rows(page).first()).toContainText("The fake provider rejected this request.");
      await page.keyboard.press("Escape");
      await expect(inbox(page)).toBeHidden();

      // The page comes to the front with that chat's pane focused: it is seen.
      await page.evaluate(() => {
        Reflect.deleteProperty(document, "hasFocus");
        window.dispatchEvent(new Event("focus"));
      });
      await expect(bell(page)).toHaveAccessibleName("Inbox");

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a chat waiting for you shows until it is answered, and Clear leaves it",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      const questions = page.getByRole("dialog", { name: "Questions from omp" });
      await send(page, 0, "ask_user");
      await expect(questions).toBeVisible({ timeout: 60_000 });

      await expect(bell(page)).toHaveAccessibleName("Inbox: 1");
      await bell(page).click();
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page).first()).toContainText("ask_user");
      await expect(rows(page).first()).toContainText("Waiting for you");
      // Nothing has finished, so there is nothing to clear; a waiting chat is not cleared.
      await expect(inbox(page).getByRole("button", { name: "Clear" })).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(inbox(page)).toBeHidden();

      await questions.getByRole("radio", { name: "Postgres" }).click();
      await questions.getByRole("button", { name: "Submit" }).click();
      await expect(questions).toBeHidden();
      await expect(bell(page)).toHaveAccessibleName("Inbox");
      await bell(page).click();
      await expect(inbox(page)).toContainText("Nothing needs you.");

      expect(realApp.problems).toEqual([]);
    },
  );
});
