import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/** The new UI's todo pill (`apps/ui`, under `/v2/`) on real omp: omp's todo list above the message box, and in full. */
realTest.describe("new UI todos", () => {
  realTest.setTimeout(240_000);
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });

  async function send(page: Page, text: string): Promise<void> {
    await box(page).fill(text);
    await box(page).press("Enter");
  }

  realTest(
    "omp's todo list shows above the box with the task it works on, follows each change, and opens in full",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/v2/" });
      await page
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: "New chat" })
        .click();
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });

      await send(page, "make_todos");
      const pill = page.getByRole("button", { name: "Todos: 0 of 2 done, now: Write the thing" });
      await expect(pill).toBeVisible({ timeout: 60_000 });

      await pill.click();
      // Exact: the pane's own region is named after the chat, "make_todos".
      const list = page.getByRole("region", { name: "Todos", exact: true });
      await expect(list.getByRole("heading", { name: "Plan" })).toBeVisible();
      await expect(list.getByRole("listitem", { name: "Now: Write the thing" })).toBeVisible();
      await expect(list.getByRole("listitem", { name: "To do: Test the thing" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(list).toHaveCount(0);

      await send(page, 'call_tool todo {"op":"done","task":"Write the thing"}');
      const next = page.getByRole("button", { name: "Todos: 1 of 2 done, now: Test the thing" });
      await expect(next).toBeVisible({ timeout: 60_000 });
      await next.click();
      await expect(list.getByRole("listitem", { name: "Done: Write the thing" })).toBeVisible();
      await expect(list.getByRole("listitem", { name: "Now: Test the thing" })).toBeVisible();

      // A reload reads the list from omp's state.
      await page.keyboard.press("Escape");
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Todos: 1 of 2 done, now: Test the thing" }),
      ).toBeVisible({ timeout: 120_000 });
      expect(realApp.problems).toEqual([]);
    },
  );
});
