import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest } from "./real-omp";

/**
 * #953 on real omp: 130 chats are in the folder, so the sidebar shows 50 and "Show older chats" pages the rest. Chat
 * 100 is shown on the first page, then its file is removed while the list stays open (the server sends no event for a
 * file that goes away, so the sidebar keeps its first page and its cursor). The next page must still start with the
 * first older chat, "Seeded chat 80", and no chat is listed twice.
 */
realTest.use({ seedSessions: 130 });

realTest(
  "a shown chat removed while the list is open does not make 'Show older chats' skip the first older chat",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 720 });
    const list = page.getByRole("listbox", { name: "Session list" });
    await expect(list.getByRole("option")).toHaveCount(50, { timeout: 60_000 });
    await expect(list.getByRole("option").first()).toContainText("Seeded chat 130");

    // Seeded chat 100 is shown on the first page. Its file name ends with its id, which counts from 0.
    const sessions = join(realApp.agentDir, "sessions");
    const files = (await readdir(sessions, { recursive: true })).filter((name) =>
      name.endsWith("_01a00000-0000-7000-8000-000000000099.jsonl"),
    );
    expect(files).toHaveLength(1);
    await rm(join(sessions, files[0] ?? ""));

    const more = page.getByRole("button", { name: "Show older chats" });
    await more.click();
    await expect(list.getByRole("option", { name: /Seeded chat 80(?!\d)/ })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(list.getByRole("option")).toHaveCount(100, { timeout: 30_000 });
    await more.click();
    await expect(list.getByRole("option", { name: /Seeded chat 1(?!\d)/ })).toHaveCount(1, {
      timeout: 30_000,
    });
    // The first page still shows the removed chat (the list is not refreshed), so 129 real chats plus that row.
    await expect(list.getByRole("option")).toHaveCount(130, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: /older chats/ })).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
