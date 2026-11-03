import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * omp's `/btw` in the new UI (`apps/ui`) on real omp: a side question opens the side panel's BTW history beside the
 * chat, which stays usable, and is answered there, out of the chat; a follow-up joins its topic; putting the history
 * away while an answer still comes says so, and the chat says when it is ready; Stop answer cancels one and keeps what
 * came; the history is there again after a reload. In Chromium and in WebKit, the desktop window's engine.
 */

export const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });
export const history = (page: Page) =>
  page
    .getByRole("complementary", { name: "Side panel" })
    .getByRole("tabpanel", { name: "BTW history" });
/** The rail's button for the BTW history: it shows the history, or puts it away when it shows. */
const railButton = (page: Page) =>
  page.getByRole("navigation", { name: "Side panel" }).getByRole("button", { name: "BTW history" });
const topics = (page: Page) => history(page).getByRole("listbox", { name: "Side questions" });
const thread = (page: Page) => history(page).getByRole("region", { name: "Side question" });

async function newChat(page: Page): Promise<void> {
  await startNewChat(page);
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
        "a side question is answered in the BTW history beside the chat, out of the chat, and a follow-up joins it",
        async ({ realApp }) => {
          const page = await realApp.open({ path: "/" });
          await newChat(page);
          // A turn of the chat's own, so a reload opens this chat again.
          await send(page, "hello");
          await expect(transcript(page).getByText("pong", { exact: true })).toBeVisible({
            timeout: 90_000,
          });

          await send(page, "/btw What is this chat about?");
          await expect(history(page)).toBeVisible();
          await expect(railButton(page)).toHaveAttribute("aria-pressed", "true");
          const first = thread(page).getByRole("article", { name: "Question" });
          await expect(first).toContainText("What is this chat about?");
          await expect(first).toContainText("pong", { timeout: 60_000 });
          await expect(topics(page).getByRole("option")).toHaveCount(1);
          await expect(topics(page).getByRole("option")).toHaveAttribute("aria-selected", "true");

          // The chat stays in view and usable beside it: the question left the box, which takes text.
          await expect(box(page)).toHaveValue("");
          await box(page).fill("typed while it shows");
          await expect(box(page)).toHaveValue("typed while it shows");
          await box(page).fill("");

          // Follow up opens a field under the answer; an empty one is refused in omp's words.
          await history(page).getByRole("button", { name: "Follow up" }).click();
          const field = history(page).getByRole("textbox", { name: "Follow up:" });
          await expect(field).toBeFocused();
          await field.press("Enter");
          await expect(history(page).getByText("Enter a follow-up question.")).toBeVisible();
          // Esc in the field puts the field away, not the history.
          await field.press("Escape");
          await expect(field).toBeHidden();
          await expect(history(page)).toBeVisible();
          await history(page).getByRole("button", { name: "Follow up" }).click();
          await field.fill("Say more.");
          await field.press("Enter");
          const followUp = thread(page).getByRole("article", { name: "Follow-up" });
          await expect(followUp).toContainText("Say more.");
          await expect(followUp).toContainText("pong", { timeout: 60_000 });
          // What you asked and what omp answered are apart, for the eye and for a screen reader (#2759).
          await expect(followUp.getByRole("region", { name: "Your question" })).toHaveText(
            "Say more.",
          );
          await expect(followUp.getByRole("region", { name: "Answer" })).toHaveText("pong");
          await expect(topics(page).getByRole("option")).toContainText("1 follow-up");

          if (engine === "chromium") {
            await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
            await history(page).getByRole("button", { name: "Copy answer" }).click();
            await expect(history(page).getByText("✓ Copied")).toBeVisible();
            await expect(history(page).getByRole("button", { name: "Copy again" })).toBeVisible();
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("pong");
          }

          // The rail's button puts it away; the chat never held the side questions.
          await railButton(page).click();
          await expect(history(page)).toBeHidden();
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
          await expect(history(page)).toBeVisible();
          await expect(topics(page).getByRole("option")).toHaveCount(1);
          await expect(thread(page).getByRole("article")).toHaveCount(2);
          await expect(box(page)).toHaveValue("");
          await railButton(page).click();
          await expect(history(page)).toBeHidden();

          expect(realApp.problems).toEqual([]);
        },
      );

      realTest(
        "putting the history away while an answer comes says so, and the chat says when it is ready; Stop answer cancels one",
        async ({ realApp }) => {
          const page = await realApp.open({ path: "/" });
          await newChat(page);

          // A side question that answers for a few seconds, put away at once.
          await send(page, "/btw stream_long_code");
          await expect(thread(page).getByText("Answering")).toBeVisible();
          await railButton(page).click();
          await expect(history(page)).toBeHidden();
          await expect(
            page.getByText("/btw is still answering in the background · /btw to reopen it"),
          ).toBeVisible();
          await expect(page.getByText("/btw answer ready · /btw to read it")).toBeVisible({
            timeout: 60_000,
          });

          // /btw opens the history on that answer, whole.
          await send(page, "/btw ");
          await expect(thread(page)).toContainText("Here is the long streamed block:");
          await expect(thread(page).getByText("Answering")).toHaveCount(0);
          await railButton(page).click();
          await expect(history(page)).toBeHidden();

          // A second, long answer: X (Stop answer) cancels it and keeps what came.
          await send(page, "/btw stream_steady");
          await expect(thread(page)).toContainText("Steady line 0", { timeout: 60_000 });
          await expect(topics(page).getByRole("option")).toHaveCount(2);
          await topics(page).getByRole("option", { selected: true }).press("x");
          await expect(topics(page).getByRole("option", { selected: true })).toContainText(
            "Cancelled",
          );
          await expect(thread(page)).toContainText("Steady line 0");
          await expect(history(page).getByRole("button", { name: "Stop answer" })).toHaveCount(0);

          expect(realApp.problems).toEqual([]);
        },
      );
    },
  );
}
