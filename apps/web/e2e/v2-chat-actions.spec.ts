import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * The new UI's chat menu (`apps/ui`, under `/v2/`) on real omp: a chat is renamed in its row, and deleted after a
 * confirmation, also while a pane shows it; a chat whose turn runs is not deleted.
 */
realTest.describe("new UI chat rename and delete", () => {
  realTest.setTimeout(240_000);
  realTest.use({ seedSessions: 2 });
  const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });
  const boxes = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });

  async function choose(page: Page, title: string, item: string): Promise<void> {
    const row = chats(page).getByRole("listitem").filter({ hasText: title });
    await row.hover();
    await row.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: item }).click();
  }

  realTest(
    "a chat is renamed in its row: Esc leaves it, Enter saves it, and omp's title stays after a reload",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await choose(page, "Seeded chat 2", "Rename");
      const field = chats(page).getByRole("textbox", { name: "Chat title" });
      await expect(field).toBeFocused();
      await expect(field).toHaveValue("Seeded chat 2");
      await field.fill("Not this");
      await field.press("Escape");
      await expect(field).toHaveCount(0);
      await expect(chats(page).getByRole("button", { name: "Seeded chat 2" })).toBeFocused();

      await choose(page, "Seeded chat 2", "Rename");
      await field.fill("  Release notes  ");
      await field.press("Enter");
      const renamed = chats(page).getByRole("button", { name: "Release notes" });
      await expect(renamed).toBeFocused();
      // Shown at once, and muted until omp has saved it.
      await expect(renamed).not.toHaveAttribute("aria-busy", "true", { timeout: 60_000 });
      await expect(chats(page).getByRole("button", { name: "Seeded chat 2" })).toHaveCount(0);

      await page.reload();
      await expect(chats(page).getByRole("button", { name: "Release notes" })).toBeVisible({
        timeout: 60_000,
      });
      expect(realApp.problems).toEqual([]);
    },
  );

  /** The page has drawn what a key changed. */
  const frame = (page: Page) =>
    page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));

  realTest(
    "the Enter that confirms an input method's word only confirms it in a chat's name (#2820)",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await choose(page, "Seeded chat 2", "Rename");
      const field = chats(page).getByRole("textbox", { name: "Chat title" });
      await field.fill("发布说明");
      // The confirming Enter as most browsers send it: still composing.
      await field.evaluate((element) =>
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      await frame(page);
      await expect(field).toHaveValue("发布说明");
      await field.press("Enter");
      await expect(chats(page).getByRole("button", { name: "发布说明" })).toBeVisible();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the Enter that confirms an input method's word only confirms it in the message box, as Safari sends it (#2820)",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
      const box = boxes(page);
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill("你好");
      // Safari's confirming Enter comes after the composition ended, with the key code 229.
      await box.evaluate((element) => {
        const enter = new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(enter, "keyCode", { value: 229 });
        element.dispatchEvent(enter);
      });
      // A send is answered within a second here; nothing may arrive in two.
      await page.waitForTimeout(2_000);
      await expect(box).toHaveValue("你好");
      await expect(transcript(page).getByText("你好")).toHaveCount(0);
      await box.press("Enter");
      await expect(transcript(page).getByText("你好")).toBeVisible({ timeout: 60_000 });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a chat a window shows is deleted after a confirmation: its row goes, its window goes blank, and it stays gone",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
      await expect(transcript(page).getByText("Seeded chat 1")).toBeVisible({ timeout: 60_000 });

      // Cancel keeps it.
      await choose(page, "Seeded chat 1", "Delete…");
      const dialog = page.getByRole("alertdialog", { name: "Delete this chat?" });
      await expect(dialog).toContainText(
        "“Seeded chat 1” and its files are deleted. This can't be undone.",
      );
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(transcript(page).getByText("Seeded chat 1")).toBeVisible();

      await choose(page, "Seeded chat 1", "Delete…");
      await dialog.getByRole("button", { name: "Delete" }).click();
      await expect(chats(page).getByRole("button", { name: /^Seeded chat 1/ })).toHaveCount(0, {
        timeout: 60_000,
      });
      await expect(transcript(page).getByText("Seeded chat 1")).toHaveCount(0);
      // Its window stays, blank, with New chat (#2791).
      await expect(page.locator("[data-tab]:not([hidden]) [data-blank-window]")).toBeVisible({
        timeout: 30_000,
      });
      await expect(boxes(page)).toHaveCount(0);
      await expect(chats(page).getByRole("alert")).toHaveCount(0);

      await page.reload();
      await expect(chats(page).getByRole("button", { name: /^Seeded chat 2/ })).toBeVisible({
        timeout: 60_000,
      });
      await expect(chats(page).getByRole("button", { name: /^Seeded chat 1/ })).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a chat put out of its pane is let go: another tab can then delete it",
    async ({ realApp }) => {
      const first = await realApp.open({ path: "/" });
      await chats(first).getByRole("button", { name: "Seeded chat 1" }).click();
      await expect(boxes(first)).toHaveAttribute("placeholder", "Message omp", {
        timeout: 120_000,
      });
      // Its window closes: this tab no longer shows the chat (a chat picked from the list now opens in a workspace of
      // its own and leaves the open ones where they are, #2831).
      await boxes(first).press("Control+Shift+W");
      await expect(first.locator("[data-blank-window]")).toBeVisible();

      const second = await realApp.open({ path: "/" });
      await choose(second, "Seeded chat 1", "Delete…");
      await second
        .getByRole("alertdialog", { name: "Delete this chat?" })
        .getByRole("button", { name: "Delete" })
        .click();
      await expect(chats(second).getByRole("button", { name: /^Seeded chat 1/ })).toHaveCount(0, {
        timeout: 60_000,
      });
      await expect(chats(second).getByRole("alert")).toHaveCount(0);
      // The first tab's list follows.
      await expect(chats(first).getByRole("button", { name: /^Seeded chat 1/ })).toHaveCount(0, {
        timeout: 60_000,
      });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a chat whose turn runs is not deleted: the list says why, and the chat stays as it was",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
      await expect(boxes(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await boxes(page).fill("stream_steady");
      await boxes(page).press("Enter");
      await expect(
        chats(page).getByRole("button", { name: /^Seeded chat 1, running/ }),
      ).toBeVisible({
        timeout: 60_000,
      });

      await choose(page, "Seeded chat 1", "Delete…");
      await page
        .getByRole("alertdialog", { name: "Delete this chat?" })
        .getByRole("button", { name: "Delete" })
        .click();
      await expect(chats(page).getByRole("alert")).toHaveText(
        "Could not delete it: Wait for this chat's turn to finish, then delete it.",
        { timeout: 60_000 },
      );
      await expect(chats(page).getByRole("button", { name: /^Seeded chat 1/ })).toBeVisible();
      await expect(transcript(page).getByText("Seeded chat 1")).toBeVisible();

      // Esc in the box stops the turn; the chat is still there to stop.
      await boxes(page).press("Escape");
      await expect(
        chats(page).getByRole("button", { name: /^Seeded chat 1, running/ }),
      ).toHaveCount(0, { timeout: 60_000 });
      expect(realApp.problems).toEqual([]);
    },
  );
});
