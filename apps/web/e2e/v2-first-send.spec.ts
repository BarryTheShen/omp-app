import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * A new chat's first message (#2828), in the new UI on real omp. omp starts a chat's first turn only after recalling
 * memories (its Hindsight backend), which takes seconds on a memory server's CPU; later turns recall nothing. Here a
 * memory server that answers a recall after 3 s: the message shows as it is sent, with the chat working, not when omp
 * starts the turn, and omp's own copy then takes its place.
 */
realTest(
  "a new chat's first message shows as it is sent while omp recalls memories before its first turn (#2828)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
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

      await box.fill("first message waits");
      await box.press("Enter");
      const sent = page
        .getByRole("region", { name: "Transcript" })
        .getByText("first message waits", { exact: true });
      const stop = page.getByRole("button", { name: "Stop" });
      await expect(sent).toBeVisible({ timeout: 1_000 });
      await expect(stop).toBeVisible({ timeout: 1_000 });
      // omp's copy takes its place: the message is there once, during the turn and after it.
      await expect(stop).toHaveCount(0, { timeout: 60_000 });
      await expect(sent).toHaveCount(1);
      expect(realApp.problems).toEqual([]);
    } finally {
      memory.close();
    }
  },
);
