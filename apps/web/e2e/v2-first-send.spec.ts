import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, type RealApp, realTest, startNewChat } from "./real-omp";

/**
 * A new chat's first message (#2828), in the new UI on real omp. omp starts a chat's first turn only after recalling
 * memories (its Hindsight backend), which takes seconds on a memory server's CPU; later turns recall nothing. Here a
 * memory server that answers a recall after 3 s.
 */

/** Opens a new chat whose omp recalls from a memory server that answers after 3 s; `close` stops that server. */
async function slowMemoryChat(realApp: RealApp): Promise<{ page: Page; close: () => void }> {
  const memory = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const reply = (): void => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ items: [], results: [], entities: {} }));
      };
      if (request.url?.endsWith("/memories/recall") === true) setTimeout(reply, 3_000);
      else reply();
    });
  });
  await new Promise<void>((resolve) => memory.listen(0, "127.0.0.1", () => resolve()));
  const close = (): void => {
    memory.close();
  };
  try {
    const { port } = memory.address() as AddressInfo;
    await writeFile(
      join(realApp.agentDir, "config.yml"),
      [
        "memory:",
        "  backend: hindsight",
        "hindsight:",
        `  apiUrl: http://127.0.0.1:${port}`,
        "  mentalModelsEnabled: false",
        "",
      ].join("\n"),
    );
    const page = await realApp.open({ path: "/" });
    const box = page.getByRole("textbox", { name: "Message" }).first();
    // The new chat kept ready since the server started predates the setting: the one after it has the memory server.
    await startNewChat(page);
    await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
    await startNewChat(page);
    await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
    return { page, close };
  } catch (failure) {
    close();
    throw failure;
  }
}

realTest(
  "a new chat's first message shows as it is sent while omp recalls memories before its first turn (#2828)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const { page, close } = await slowMemoryChat(realApp);
    try {
      const box = page.getByRole("textbox", { name: "Message" }).first();
      await box.fill("first message waits");
      await box.press("Enter");
      const sent = page
        .getByRole("region", { name: "Transcript" })
        .getByText("first message waits", { exact: true });
      const stop = page.getByRole("button", { name: "Stop" });
      // The message and Stop show as it is sent, not after the recall.
      await expect(sent).toBeVisible({ timeout: 1_000 });
      await expect(stop).toBeVisible({ timeout: 1_000 });
      // omp's copy takes its place: the message is there once, during the turn and after it.
      await expect(stop).toHaveCount(0, { timeout: 60_000 });
      await expect(sent).toHaveCount(1);
      expect(realApp.problems).toEqual([]);
    } finally {
      close();
    }
  },
);

realTest(
  "Stop pressed while omp still recalls memories ends the wait, and the message goes back to the box (#2828)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const { page, close } = await slowMemoryChat(realApp);
    try {
      const box = page.getByRole("textbox", { name: "Message" }).first();
      // The chat list names the chat by this text: no "Stop" or "Send" in it, and the buttons matched by their whole names.
      await box.fill("taken back before its turn");
      await box.press("Enter");
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      await expect(stop).toBeVisible({ timeout: 1_000 });
      await stop.click();
      // omp drops a message it had not started: the chat stops working, and the message is in the box again.
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(stop).toHaveCount(0);
      await expect(box).toHaveValue("taken back before its turn");
      await expect(
        page
          .getByRole("region", { name: "Transcript" })
          .getByText("taken back before its turn", { exact: true }),
      ).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    } finally {
      close();
    }
  },
);
