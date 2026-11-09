import { createServer } from "node:http";
import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * The dashboard's to-do list (D7) on real omp: what you add is kept on the server, reaches another device at once and
 * comes back after a reload; an item is ticked off, started, edited, moved and removed; each change says who made it
 * and the newest can be taken back.
 */
const todoList = (page: Page) =>
  page.locator('[data-tour="dashboard"]').getByRole("region", { name: "To-do list" });

async function openList(page: Page) {
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  const list = todoList(page);
  await expect(list.getByText(/\d+ to do/)).toBeVisible({ timeout: 30_000 });
  return list;
}

async function add(page: Page, title: string, listName?: string): Promise<void> {
  const list = todoList(page);
  if (listName !== undefined) await list.getByLabel("To the list").fill(listName);
  await list.getByLabel("New to-do").fill(title);
  await list.getByLabel("New to-do").press("Enter");
  await expect(list.getByRole("listitem", { name: title })).toBeVisible();
}

realTest.describe("new UI: the dashboard's to-do list", () => {
  realTest.setTimeout(180_000);

  realTest(
    "kept on the server for every device; ticked, started, edited, moved and removed; the newest change taken back",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      const list = await openList(page);
      await expect(list).toContainText("Nothing to do.");
      await add(page, "Write the plan");
      await add(page, "Send the report");
      await add(page, "Call the bank");
      await add(page, "Read chapter 4", "School");
      await expect(list.getByRole("region", { name: "School" })).toBeVisible();
      await expect(list.getByText("4 to do")).toBeVisible();

      // Another device sees it at once, and its tick reaches this one.
      const other = await realApp.open({ path: "/" });
      const there = await openList(other);
      await expect(there.getByRole("listitem")).toHaveCount(4);
      await there.getByRole("checkbox", { name: "Done: Write the plan" }).click();
      await expect(list.getByRole("listitem", { name: "Write the plan" })).toHaveCount(0);
      await expect(list.getByText("3 to do")).toBeVisible();
      await list.getByRole("group", { name: "Show" }).getByRole("button", { name: "Done" }).click();
      await expect(list.getByRole("checkbox", { name: "Done: Write the plan" })).toBeChecked();
      await list
        .getByRole("group", { name: "Show" })
        .getByRole("button", { name: "To do" })
        .click();

      // Ordered: the bank's call goes above the report, and the other device sees the new order.
      const toDo = list.getByRole("list", { name: "To do: its items" });
      await expect(toDo.getByRole("listitem").first()).toHaveAccessibleName("Send the report");
      await toDo.getByRole("button", { name: "Move up: Call the bank" }).click();
      await expect(toDo.getByRole("listitem").first()).toHaveAccessibleName("Call the bank");
      await expect(
        there.getByRole("list", { name: "To do: its items" }).getByRole("listitem").first(),
      ).toHaveAccessibleName("Call the bank");

      // Edited and started.
      const chapter = list.getByRole("listitem", { name: "Read chapter 4" });
      await chapter.getByRole("button", { name: "Edit Read chapter 4" }).click();
      const editor = list.getByRole("form", { name: "Edit Read chapter 4" });
      await editor.getByLabel("Title").fill("Read chapters 4 and 5");
      await editor.getByLabel("Notes").fill("Before Thursday");
      await editor.getByRole("button", { name: "Save" }).click();
      const chapters = list.getByRole("listitem", { name: "Read chapters 4 and 5" });
      await expect(chapters).toContainText("Notes");
      await chapters.getByRole("button", { name: "Start Read chapters 4 and 5" }).click();
      await expect(chapters).toContainText("Doing");
      await expect(list).toContainText("You started “Read chapters 4 and 5”");

      // The newest change taken back: no longer started.
      await list.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(chapters).not.toContainText("Doing");
      await expect(list).toContainText("You took back a change to “Read chapters 4 and 5”");

      // Removed, and every change listed with who made it.
      await chapters.getByRole("button", { name: "Remove Read chapters 4 and 5" }).click();
      await expect(chapters).toHaveCount(0);
      await expect(there.getByRole("listitem", { name: "Read chapters 4 and 5" })).toHaveCount(0);
      await list.getByRole("button", { name: "All changes" }).click();
      const changes = list.getByRole("list", { name: "Changes, newest first" });
      await expect(changes.getByRole("listitem").first()).toContainText(
        "You removed “Read chapters 4 and 5”",
      );
      await expect(changes).toContainText("You marked done “Write the plan”");

      // Kept: a reload brings the list back as it was.
      await page.reload();
      const again = todoList(page);
      await expect(again.getByRole("listitem", { name: "Send the report" })).toBeVisible({
        timeout: 60_000,
      });
      await expect(again.getByText("2 to do")).toBeVisible();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a copy in SiYuan, set from the dashboard: written at the page's end with the token, rewritten after a change; the token is not shown again",
    async ({ realApp }) => {
      // A stand-in for SiYuan's API: it keeps each block's Markdown and the token each call brings.
      const blocks = new Map<string, string>();
      const tokens: string[] = [];
      const siyuan = createServer((request, response) => {
        let text = "";
        request.on("data", (chunk) => {
          text += chunk;
        });
        request.on("end", () => {
          tokens.push(String(request.headers.authorization));
          const body = JSON.parse(text) as { id?: string; data?: string; parentID?: string };
          response.setHeader("Content-Type", "application/json");
          if (request.url === "/api/block/appendBlock") {
            blocks.set("20261109000001-copyabc", String(body.data));
            response.end(
              JSON.stringify({
                code: 0,
                data: [{ doOperations: [{ id: "20261109000001-copyabc" }] }],
              }),
            );
          } else if (request.url === "/api/block/updateBlock" && blocks.has(String(body.id))) {
            blocks.set(String(body.id), String(body.data));
            response.end(JSON.stringify({ code: 0, data: [] }));
          } else response.end(JSON.stringify({ code: -1, msg: "no such block" }));
        });
      });
      await new Promise<void>((resolve) => siyuan.listen(0, "127.0.0.1", resolve));
      const port = (siyuan.address() as { port: number }).port;
      try {
        const page = await realApp.open({ path: "/" });
        const list = await openList(page);
        await add(page, "Write the plan");
        const copy = list.getByRole("region", { name: "Copy in SiYuan" });
        await expect(copy).toContainText("Off.");
        await copy.getByRole("button", { name: "Set it up" }).click();
        const form = copy.getByRole("form", { name: "The copy in SiYuan" });
        await form.getByLabel("SiYuan's address").fill(`http://127.0.0.1:${port}`);
        await form.getByLabel("API token").fill("token-123");
        await form.getByLabel("The page's id").fill("20240101120000-abcdefg");
        await form.getByRole("button", { name: "Save and write it" }).click();
        await expect(copy).toContainText("Written at", { timeout: 30_000 });
        expect(tokens).toEqual(["Token token-123"]);
        expect(blocks.get("20261109000001-copyabc")).toContain("- [ ] Write the plan");

        // A change rewrites the same block a moment later.
        await add(page, "Send the report");
        await expect
          .poll(() => blocks.get("20261109000001-copyabc") ?? "", { timeout: 30_000 })
          .toContain("- [ ] Send the report");
        expect(blocks.size).toBe(1);

        // The token is never shown again: the field says it is saved.
        await copy.getByRole("button", { name: "Change" }).click();
        await expect(form.getByLabel("API token")).toHaveValue("");
        await expect(form.getByLabel("API token")).toHaveAttribute(
          "placeholder",
          "Saved; type a new one to change it",
        );
        expect(realApp.problems).toEqual([]);
      } finally {
        siyuan.close();
      }
    },
  );
});
