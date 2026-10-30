/**
 * The chat host's `get_model_menu`, end to end on real omp with the fake model provider: the models the chat's model
 * menu lists, each provider's newest first, and omp's own history of the models used most recently. Runs from source
 * and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chatHostChats, PROGRAMS, realTest } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

describe("the chat host's model menu", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: lists each provider's newest models first, and the models switched to, newest first`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const first = await chat.client.request("get_model_menu", {});
        const ids = first.models.map((model) => `${model.provider}/${model.modelId}`);
        // A newer version of a model comes before an older one; models without a version come after those with one.
        const at = (id: string) => ids.indexOf(`fake/${id}`);
        expect(at("claude-fable-5")).toBeGreaterThanOrEqual(0);
        expect(at("claude-fable-5")).toBeLessThan(at("claude-3-5-sonnet-20240620"));
        expect(at("claude-3-5-sonnet-20240620")).toBeLessThan(at("claude-3-haiku-20240307"));
        expect(at("claude-3-haiku-20240307")).toBeLessThan(at("fake-model"));
        expect(first.models.find((model) => model.modelId === "claude-fable-5")?.name).toBe(
          "Claude Fable 5",
        );

        // Each switch goes to the front of omp's history, and the menu lists it so.
        await chat.client.request("set_model", {
          provider: "fake",
          modelId: "claude-3-haiku-20240307",
        });
        // omp stamps each switch in whole seconds in its own database (`agent-storage.ts`, `strftime('%s','now')`),
        // a clock this test cannot set: two switches in one second tie, so the second waits for the next second.
        await Bun.sleep(1_100);
        await chat.client.request("set_model", { provider: "fake", modelId: "claude-fable-5" });
        const after = await chat.client.request("get_model_menu", {});
        expect(after.recent.slice(0, 2)).toEqual([
          "fake/claude-fable-5",
          "fake/claude-3-haiku-20240307",
        ]);
        // Recent names only models the menu lists.
        for (const key of after.recent) expect(ids).toContain(key);
      },
      60_000,
    );
  }
});
