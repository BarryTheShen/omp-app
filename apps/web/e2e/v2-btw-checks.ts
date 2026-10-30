import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * omp's `/btw` in the new UI (`apps/ui`) on real omp: a side question opens the BTW history sheet and is answered there,
 * out of the chat; a follow-up joins its topic; Esc puts the sheet away while an answer still comes, the chat says so and
 * says when it is ready; Stop answer cancels one and keeps what came; the history is there again after a reload. In
 * Chromium and in WebKit, the desktop window's engine.
 */
const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });
export const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });
export const sheet = (page: Page) => page.getByRole("dialog", { name: "BTW history" });
const topics = (page: Page) => sheet(page).getByRole("listbox", { name: "Side questions" });
const thread = (page: Page) => sheet(page).getByRole("region", { name: "Side question" });

async function newChat(page: Page): Promise<void> {
  await chats(page).getByRole("button", { name: "New chat" }).click();
  await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
}

async function send(page: Page, text: string): Promise<void> {
  await box(page).fill(text);
  await box(page).press("Enter");
}

/** The side questions' checks in one engine: Chromium, or WebKit (the desktop window's), each from its own spec file. */
export function defineBtwChecks(engine: "chromium" | "webkit"): void {
  realTest.describe(
    `new UI side questions in ${engine === "webkit" ? "WebKit" : "Chromium"}`,
    () => {
      realTest.setTimeout(240_000);

      realTest(
        "a side question is answered in the BTW history, out of the chat, and a follow-up joins it",
        async ({ realApp }) => {
          const page = await realApp.open({ path: "/" });
          await newChat(page);
          // A turn of the chat's own, so a reload opens this chat again.
          await send(page, "hello");
          await expect(transcript(page).getByText("pong", { exact: true })).toBeVisible({
            timeout: 90_000,
          });

          await send(page, "/btw What is this chat about?");
          await expect(sheet(page)).toBeVisible();
          const first = thread(page).getByRole("article", { name: "Question" });
          await expect(first).toContainText("What is this chat about?");
          await expect(first).toContainText("pong", { timeout: 60_000 });
          await expect(topics(page).getByRole("option")).toHaveCount(1);
          await expect(topics(page).getByRole("option")).toHaveAttribute("aria-selected", "true");

          // Follow up opens a field under the answer; an empty one is refused in omp's words.
          await sheet(page).getByRole("button", { name: "Follow up" }).click();
          const field = sheet(page).getByRole("textbox", { name: "Follow up:" });
          await expect(field).toBeFocused();
          await field.press("Enter");
          await expect(sheet(page).getByText("Enter a follow-up question.")).toBeVisible();
          // Esc in the field puts the field away, not the sheet.
          await field.press("Escape");
          await expect(field).toBeHidden();
          await expect(sheet(page)).toBeVisible();
          await sheet(page).getByRole("button", { name: "Follow up" }).click();
          await field.fill("Say more.");
          await field.press("Enter");
          const followUp = thread(page).getByRole("article", { name: "Follow-up" });
          await expect(followUp).toContainText("Say more.");
          await expect(followUp).toContainText("pong", { timeout: 60_000 });
          await expect(topics(page).getByRole("option")).toContainText("1 follow-up");

          if (engine === "chromium") {
            await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
            await sheet(page).getByRole("button", { name: "Copy answer" }).click();
            await expect(sheet(page).getByText("✓ Copied")).toBeVisible();
            await expect(sheet(page).getByRole("button", { name: "Copy again" })).toBeVisible();
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("pong");
          }

          // Esc puts the sheet away (an open sheet hides the rest of the page from assistive tech, so the box is read
          // after it): the question left the box, and the chat never held the side questions.
          await page.keyboard.press("Escape");
          await expect(sheet(page)).toBeHidden();
          await expect(box(page)).toHaveValue("");
          await expect(transcript(page).getByText("What is this chat about?")).toHaveCount(0);
          await expect(transcript(page).getByText("Say more.")).toHaveCount(0);

          // After a reload, /btw alone opens the history again: /btw comes from the menu, with omp's words.
          await page.reload();
          await expect(box(page)).toHaveAttribute("placeholder", "Message omp", {
            timeout: 120_000,
          });
          await box(page).fill("/btw");
          const commands = page.getByRole("listbox", { name: "omp's commands" });
          await expect(
            commands.getByRole("option", {
              name: /^\/btw.*Ask a side question, or browse this session's BTW history/,
            }),
          ).toBeVisible({ timeout: 30_000 });
          await box(page).press("Enter");
          await expect(box(page)).toHaveValue("/btw ");
          await box(page).press("Enter");
          await expect(sheet(page)).toBeVisible();
          await expect(topics(page).getByRole("option")).toHaveCount(1);
          await expect(thread(page).getByRole("article")).toHaveCount(2);
          await page.keyboard.press("Escape");
          await expect(sheet(page)).toBeHidden();
          await expect(box(page)).toHaveValue("");

          expect(realApp.problems).toEqual([]);
        },
      );

      realTest(
        "Esc puts the sheet away while an answer comes and the chat says when it is ready; Stop answer cancels one",
        async ({ realApp }) => {
          const page = await realApp.open({ path: "/" });
          await newChat(page);

          // A side question that answers for a few seconds, put away at once.
          await send(page, "/btw stream_long_code");
          await expect(thread(page).getByText("Answering")).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(sheet(page)).toBeHidden();
          await expect(
            page.getByText("/btw is still answering in the background · /btw to reopen it"),
          ).toBeVisible();
          await expect(page.getByText("/btw answer ready · /btw to read it")).toBeVisible({
            timeout: 60_000,
          });

          // /btw opens the sheet on that answer, whole.
          await send(page, "/btw ");
          await expect(thread(page)).toContainText("Here is the long streamed block:");
          await expect(thread(page).getByText("Answering")).toHaveCount(0);
          await page.keyboard.press("Escape");
          await expect(sheet(page)).toBeHidden();

          // A second, long answer: X (Stop answer) cancels it and keeps what came.
          await send(page, "/btw stream_steady");
          await expect(thread(page)).toContainText("Steady line 0", { timeout: 60_000 });
          await expect(topics(page).getByRole("option")).toHaveCount(2);
          await topics(page).getByRole("option", { selected: true }).press("x");
          await expect(topics(page).getByRole("option", { selected: true })).toContainText(
            "Cancelled",
          );
          await expect(thread(page)).toContainText("Steady line 0");
          await expect(sheet(page).getByRole("button", { name: "Stop answer" })).toHaveCount(0);

          expect(realApp.problems).toEqual([]);
        },
      );
    },
  );
}
