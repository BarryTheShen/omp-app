import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * Queued tasks (#14) on real omp: Queue for later beside Send makes the typed message a task for the chat, which the
 * server sends as soon as the chat is free (the box clears at once); the dashboard's Tasks list it as sent; a task set
 * for a time waits until Send now lets it go; and two waiting tasks change places with the arrows. On a phone, Queue
 * for later is a row of ＋ once words are typed, and its sheet queues the same way.
 */
const dashboard = (page: Page) => page.locator('[data-tour="dashboard"]');
const workspaces = (page: Page) => page.getByRole("tablist", { name: "Workspaces" });
const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });

realTest.describe("new UI: queued tasks", () => {
  realTest.setTimeout(240_000);

  realTest(
    "Queue for later sends when the chat is free; a timed task waits for Send now; the arrows reorder the waiting ones",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill("hello");
      await box.press("Enter");
      await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
        timeout: 90_000,
      });

      // Queue for later, when the chat is free: it is free, so the server sends it at once.
      await box.fill("queued while free");
      await page.getByRole("button", { name: "Queue for later" }).click();
      const later = page.getByRole("dialog", { name: "Queue for later" });
      await later.getByRole("radio", { name: "When this chat is free" }).click();
      await later.getByRole("button", { name: "Queue it" }).click();
      await expect(later).toHaveCount(0);
      await expect(box).toHaveValue("");
      await expect(transcript(page).getByText("queued while free")).toBeVisible({
        timeout: 60_000,
      });
      await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(2, {
        timeout: 90_000,
      });

      // The dashboard lists it as sent.
      await page.getByRole("button", { name: "Dashboard", exact: true }).click();
      const tasks = dashboard(page).getByRole("region", { name: "Tasks" });
      await expect(tasks).toContainText("No task waits", { timeout: 30_000 });
      await tasks.getByText(/^Sent and failed \(1\)$/).click();
      await expect(tasks.getByRole("list", { name: "Done tasks" })).toContainText(
        "queued while free",
      );

      // Two tasks for an hour from now wait in the order queued; the arrows swap them; Send now lets one go.
      for (const text of ["first in an hour", "second in an hour"]) {
        await tasks.getByRole("button", { name: "New task" }).click();
        const form = tasks.getByRole("form", { name: "New task" });
        await form.getByLabel("Message").fill(text);
        await form.getByRole("radio", { name: "At a time" }).click();
        await form.getByRole("button", { name: "Queue it" }).click();
        await expect(form).toHaveCount(0);
      }
      const waiting = tasks.getByRole("list", { name: "Waiting tasks" }).getByRole("listitem");
      await expect(waiting).toHaveCount(2, { timeout: 30_000 });
      await expect(waiting.nth(0)).toContainText("first in an hour");
      await expect(waiting.nth(0)).toContainText(/ · At /);
      await waiting.nth(0).getByRole("button", { name: "Move down" }).click();
      await expect(waiting.nth(0)).toContainText("second in an hour", { timeout: 30_000 });

      await waiting.nth(0).getByRole("button", { name: "Send now" }).click();
      await expect(waiting).toHaveCount(1, { timeout: 60_000 });
      await expect(waiting.nth(0)).toContainText("first in an hour");
      await workspaces(page).getByRole("tab").first().click();
      await expect(transcript(page).getByText("second in an hour")).toBeVisible({
        timeout: 60_000,
      });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "on a phone, Queue for later is a row of ＋ once words are typed, and its sheet queues the message",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      // A phone opens in a new chat.
      const page = await realApp.open({ path: "/", context });
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Fake Model · high", { timeout: 120_000 });
      await box.fill("hello");
      await page.getByRole("button", { name: "Send" }).tap();
      await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
        timeout: 90_000,
      });

      // Nothing typed: ＋ has no Queue for later.
      const plus = page.locator("[data-tour='plus-sheet']");
      await page.getByRole("button", { name: "More" }).tap();
      await expect(plus.getByRole("button", { name: "Quick prompts" })).toBeVisible();
      await expect(plus.getByRole("button", { name: "Queue for later" })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(plus).toHaveCount(0);

      // Typed: its row opens its sheet over ＋; queued, both close and the free chat gets it at once.
      await box.fill("queued from a phone");
      await page.getByRole("button", { name: "More" }).tap();
      await plus.getByRole("button", { name: "Queue for later" }).tap();
      const later = page.getByRole("dialog", { name: "Queue for later" });
      await later.getByRole("radio", { name: "When this chat is free" }).tap();
      await later.getByRole("button", { name: "Queue it" }).tap();
      await expect(later).toHaveCount(0);
      await expect(plus).toHaveCount(0);
      await expect(box).toHaveValue("");
      await expect(transcript(page).getByText("queued from a phone")).toBeVisible({
        timeout: 60_000,
      });
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );
});
