import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The Files panel (#2782) on the real server: a folder's files listed, opened, edited and saved; a change made outside
 * reloads an unedited file; a save over a changed file stops and asks, and Overwrite and Save as copy each leave what
 * they say on disk; files dropped in are uploaded; a delete comes back with Undo; and an HTML preview runs in a sandbox
 * that reaches none of the app's page, cookies, storage or socket.
 */
realTest.describe("new UI: the Files panel", () => {
  realTest.setTimeout(240_000);

  const panel = (page: Page) => page.locator("[data-tour='files-panel']");
  const tree = (page: Page) => page.getByRole("tree", { name: "Files" });
  const row = (page: Page, name: string) => tree(page).getByRole("treeitem", { name, exact: true });
  const editor = (page: Page) => page.locator(".cm-content");

  /** A new chat open (the panel follows the focused chat), then the Files panel from the rail. */
  async function openFiles(page: Page): Promise<void> {
    await startNewChat(page);
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "placeholder",
      "Message omp",
      {
        timeout: 120_000,
      },
    );
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await expect(panel(page)).toBeVisible();
  }

  /** Opens `notes/plan.md` from a collapsed `notes`, and puts its editor in Edit. */
  async function openPlan(page: Page): Promise<void> {
    await row(page, "notes").click();
    await row(page, "plan.md").click();
    await page.getByRole("button", { name: "Source" }).click();
    await page.getByRole("button", { name: "Edit" }).click();
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  }

  /** Replaces the editor's text by typing. */
  async function type(page: Page, text: string): Promise<void> {
    await editor(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(text);
  }

  realTest(
    "a Markdown file opens from its directory, edits and saves; a change made outside reloads it",
    async ({ realApp }) => {
      await mkdir(join(realApp.folder, "notes"), { recursive: true });
      await writeFile(join(realApp.folder, "notes", "plan.md"), "# Plan\n");
      const page = await realApp.open({ path: "/" });
      await openFiles(page);
      await openPlan(page);
      // A paragraph, not a list item: Enter on a list item starts the next one (the editor's Markdown keys).
      await type(page, "# Plan\n\nShip it.\n");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Saved", { exact: true })).toBeVisible();
      expect(await readFile(join(realApp.folder, "notes", "plan.md"), "utf8")).toBe(
        "# Plan\n\nShip it.\n",
      );

      // No edits now: an outside change shows in place.
      await appendFile(join(realApp.folder, "notes", "plan.md"), "- from outside\n");
      await expect(editor(page)).toContainText("from outside", { timeout: 10_000 });
      await expect(page.getByText("Updated", { exact: true })).toBeVisible();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a save over a file changed on disk stops and asks; Overwrite and Save as copy each leave what they say",
    async ({ realApp }) => {
      const plan = join(realApp.folder, "notes", "plan.md");
      await mkdir(join(realApp.folder, "notes"), { recursive: true });
      await writeFile(plan, "first\n");
      const page = await realApp.open({ path: "/" });
      await openFiles(page);
      await openPlan(page);

      await type(page, "mine\n");
      await appendFile(plan, "theirs\n");
      await expect(page.getByText("Changed on disk while you were editing.")).toBeVisible({
        timeout: 10_000,
      });
      await page.getByRole("button", { name: "Save" }).click();
      const dialog = page.getByRole("dialog", { name: "This file changed since you opened it" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Overwrite" }).click();
      await expect(dialog).toHaveCount(0);
      expect(await readFile(plan, "utf8")).toBe("mine\n");

      await type(page, "mine again\n");
      await appendFile(plan, "theirs again\n");
      await expect(page.getByText("Changed on disk while you were editing.")).toBeVisible({
        timeout: 10_000,
      });
      await page.getByRole("button", { name: "Save" }).click();
      await dialog.getByRole("button", { name: "Save as copy" }).click();
      await expect(dialog).toHaveCount(0);
      expect(await readFile(plan, "utf8")).toBe("mine\ntheirs again\n");
      await expect(row(page, "plan.md")).toBeVisible();
      const copy = tree(page).getByRole("treeitem", {
        name: /^plan \(conflict \d{4}-\d{2}-\d{2} \d{4}\)\.md$/,
      });
      await expect(copy).toBeVisible({ timeout: 10_000 });
      const copyName = (await copy.getAttribute("aria-label")) ?? "";
      expect(await readFile(join(realApp.folder, "notes", copyName), "utf8")).toBe("mine again\n");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "files dropped on the panel are uploaded, and a delete comes back with Undo",
    async ({ realApp }) => {
      await writeFile(join(realApp.folder, "keep.txt"), "kept\n");
      const page = await realApp.open({ path: "/" });
      await openFiles(page);
      await expect(row(page, "keep.txt")).toBeVisible();

      const dropped = await page.evaluateHandle(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(["dropped bytes\n"], "dropped.txt", { type: "text/plain" }));
        return transfer;
      });
      await panel(page).dispatchEvent("dragover", { dataTransfer: dropped });
      await panel(page).dispatchEvent("drop", { dataTransfer: dropped });
      await expect(row(page, "dropped.txt")).toBeVisible({ timeout: 10_000 });
      expect(await readFile(join(realApp.folder, "dropped.txt"), "utf8")).toBe("dropped bytes\n");

      await row(page, "keep.txt").hover();
      await page.getByRole("button", { name: "More for keep.txt" }).click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await expect(row(page, "keep.txt")).toHaveCount(0);
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(row(page, "keep.txt")).toBeVisible({ timeout: 10_000 });
      expect(await readFile(join(realApp.folder, "keep.txt"), "utf8")).toBe("kept\n");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "an HTML preview runs sandboxed: it reaches neither the app's page, its cookies, its storage nor its socket",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      const socketUrl = new URL("/ws", page.url()).toString().replace(/^http/, "ws");
      await writeFile(
        join(realApp.folder, "probe.html"),
        `<!doctype html><title>probe</title><script>
const tried = {};
try { tried.parent = String(parent.document.title); } catch { tried.parent = "blocked"; }
try { tried.cookie = document.cookie; tried.cookie = "read"; } catch { tried.cookie = "blocked"; }
try { localStorage.setItem("probe", "1"); tried.storage = "used"; } catch { tried.storage = "blocked"; }
let told = false;
const tell = (socket) => {
  if (told) return;
  told = true;
  tried.socket = socket;
  parent.postMessage({ probe: tried }, "*");
};
try {
  const socket = new WebSocket(${JSON.stringify(socketUrl)});
  socket.onmessage = () => tell("reached");
  socket.onclose = (event) => tell("closed " + event.code);
} catch { tell("blocked"); }
</script>`,
      );
      await page.evaluate(() => {
        (window as unknown as { probe?: unknown }).probe = null;
        addEventListener("message", (event) => {
          const data = event.data as { probe?: unknown };
          if (data?.probe !== undefined)
            (window as unknown as { probe?: unknown }).probe = data.probe;
        });
      });
      await openFiles(page);
      await row(page, "probe.html").click();
      const frame = page.locator("iframe[title='probe.html, rendered']");
      await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
      // The socket may open: the server closes a page of another origin (here "null") at once, with 4403, before a word.
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { probe?: unknown }).probe), {
          timeout: 15_000,
        })
        .toEqual({
          parent: "blocked",
          cookie: "blocked",
          storage: "blocked",
          socket: "closed 4403",
        });
      expect(realApp.problems.filter((problem) => !problem.includes("WebSocket"))).toEqual([]);
    },
  );

  realTest(
    "after a reload the panel shows the folder as it listed it last, at once, while the new listing is still on its way (#2785)",
    async ({ realApp }) => {
      await writeFile(join(realApp.folder, "kept-list.txt"), "listed\n");
      // Once set, the page's listing calls never leave it, as on a connection where they wait behind a chat's history.
      let holdListings = false;
      const page = await realApp.open({
        path: "/",
        beforeLoad: async (target) => {
          await target.routeWebSocket(/\/ws\?/, (socket) => {
            const server = socket.connectToServer();
            server.onMessage((message) => socket.send(message));
            socket.onMessage((message) => {
              const text = typeof message === "string" ? message : message.toString("utf8");
              const listing =
                text.includes('"A1.workspaceFiles"') && text.includes('"method":"list"');
              if (holdListings && listing) return;
              server.send(message);
            });
          });
        },
      });
      await openFiles(page);
      await expect(row(page, "kept-list.txt")).toBeVisible({ timeout: 30_000 });

      holdListings = true;
      await page.reload();
      await expect(panel(page)).toBeVisible({ timeout: 60_000 });
      await expect(row(page, "kept-list.txt")).toBeVisible({ timeout: 10_000 });
      await expect(panel(page).getByText("Listing the folder…")).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );
});
