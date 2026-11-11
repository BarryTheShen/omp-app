/**
 * The chat host's search engine methods (#11, #12), end to end on the fake model provider. Keys go to the chat's
 * throwaway agent folder through omp's auth API, and nothing here reaches a search engine: the one test search is of
 * an engine without a key, which omp refuses before any request. Runs from source and compiled
 * (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { SearchEngine } from "@omp-app/contracts/chat-host";
import { chatHostChats, PROGRAMS, realTest } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

/** Two made-up TinyFish keys; their tails are what must never come back. */
const TAIL_A = "a1".repeat(12);
const TAIL_B = "b2".repeat(12);
const KEY_A = `sk-tinyfish-${TAIL_A}`;
const KEY_B = `sk-tinyfish-${TAIL_B}`;

function engineIn(engines: readonly SearchEngine[], id: string): SearchEngine {
  const engine = engines.find((each) => each.id === id);
  if (engine === undefined) throw new Error(`no engine ${id} in ${engines.map((each) => each.id)}`);
  return engine;
}

describe("the chat host's search engines", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: each engine says how it gets a key and whether omp can search with it`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const { engines } = await chat.client.request("get_search_engines", {});
        // No login in omp: a key field, with the engine's own key page.
        expect(engineIn(engines, "tinyfish")).toEqual({
          id: "tinyfish",
          name: "TinyFish",
          access: "key",
          keyProvider: "tinyfish",
          savedKeys: 0,
          ready: false,
          whenPicked: false,
          keyPage: "https://agent.tinyfish.ai/api-keys",
          keyHint: "sk-tinyfish-...",
          sharedWithModels: false,
        });
        // Keenable searches without a key when picked (its public endpoint), never in the automatic order.
        expect(engineIn(engines, "keenable")).toMatchObject({
          access: "key",
          ready: false,
          whenPicked: true,
        });
        // omp's own API-key login gives Kagi's key page and what a key looks like.
        expect(engineIn(engines, "kagi")).toMatchObject({
          access: "key",
          keyPage: "https://kagi.com/settings/api",
          keyHint: "KG_...",
        });
        // Kimi's key is Kimi Code's sign-in.
        expect(engineIn(engines, "kimi")).toMatchObject({
          access: "sign_in",
          keyProvider: "kimi-code",
          keyProviderName: "Kimi Code",
        });
        expect(engineIn(engines, "duckduckgo")).toMatchObject({ access: "none", ready: true });
        // The session model's placeholder is no engine.
        expect(engines.map((each) => each.id)).not.toContain("hosted");
      },
      60_000,
    );

    programTest(
      `${program.name}: a saved key readies the engine, a new key replaces it, the same key again stays, and Remove takes it`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const saved = await chat.client.request("set_search_key", {
          engine: "tinyfish",
          key: `  ${KEY_A}\n`,
        });
        expect(saved.engine).toMatchObject({ key: { from: "saved" }, savedKeys: 1, ready: true });
        expect(JSON.stringify(saved)).not.toContain(TAIL_A);

        const replaced = await chat.client.request("set_search_key", {
          engine: "tinyfish",
          key: KEY_B,
        });
        expect(replaced.engine).toMatchObject({ savedKeys: 1, ready: true });
        const again = await chat.client.request("set_search_key", {
          engine: "tinyfish",
          key: KEY_B,
        });
        expect(again.engine).toMatchObject({ savedKeys: 1, ready: true });

        const { engines } = await chat.client.request("get_search_engines", {});
        expect(engineIn(engines, "tinyfish")).toMatchObject({ savedKeys: 1, ready: true });
        expect(JSON.stringify(engines)).not.toContain(TAIL_B);

        const removed = await chat.client.request("remove_search_key", { engine: "tinyfish" });
        expect(removed.removed).toBe(1);
        expect(removed.engine).toMatchObject({ savedKeys: 0, ready: false });
        expect(removed.engine.key).toBeUndefined();
      },
      60_000,
    );

    programTest(
      `${program.name}: an engine with omp's API-key login stores its key through that login`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const { engine } = await chat.client.request("set_search_key", {
          engine: "kagi",
          key: "KG_made-up-key",
        });
        expect(engine).toMatchObject({ key: { from: "saved" }, savedKeys: 1, ready: true });
      },
      60_000,
    );

    programTest(
      `${program.name}: no key is taken for an engine that needs none, signs in another way or does not exist`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await expect(
          chat.client.request("set_search_key", { engine: "duckduckgo", key: KEY_A }),
        ).rejects.toMatchObject({ message: "DuckDuckGo needs no key." });
        await expect(
          chat.client.request("set_search_key", { engine: "kimi", key: KEY_A }),
        ).rejects.toMatchObject({
          message: "Kimi signs in with a Kimi Code account, not a key.",
        });
        await expect(
          chat.client.request("set_search_key", { engine: "nope", key: KEY_A }),
        ).rejects.toMatchObject({ message: 'omp has no search engine "nope".' });
        await expect(
          chat.client.request("set_search_key", { engine: "tinyfish", key: "  \n" }),
        ).rejects.toMatchObject({ message: "The key is empty." });
        const { engines } = await chat.client.request("get_search_engines", {});
        expect(engineIn(engines, "tinyfish").savedKeys).toBe(0);
      },
      60_000,
    );

    programTest(
      `${program.name}: a test search of an engine without its key fails in omp's words`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        expect(await chat.client.request("test_search", { engine: "tinyfish" })).toMatchObject({
          ok: false,
          message:
            "TinyFish web search is unavailable. Configure its credentials or select the automatic provider chain.",
        });
      },
      60_000,
    );

    programTest(
      `${program.name}: the order is omp's own: its defaults until fallbacks are set, then those after the first`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const before = await chat.client.request("get_search_engines", {});
        expect(before.fallbacksSet).toBe(false);
        const [first] = before.order;
        if (first === undefined) throw new Error("omp resolved no search engine for the web role");
        await chat.client.request("set_role_fallbacks", {
          role: "web",
          chain: ["web/keenable", "web/tinyfish"],
        });
        const after = await chat.client.request("get_search_engines", {});
        expect(after.fallbacksSet).toBe(true);
        expect(after.order).toEqual([first, "web/keenable", "web/tinyfish"]);
        // A search engine takes the role, as omp's hub gives it one: it searches first, the fallbacks after it.
        expect(
          await chat.client.request("assign_model_role", {
            provider: "web",
            modelId: "tinyfish",
            role: "web",
            thinkingLevel: "inherit",
          }),
        ).toMatchObject({ applied: true });
        expect((await chat.client.request("get_search_engines", {})).order).toEqual([
          "web/tinyfish",
          "web/keenable",
        ]);
      },
      60_000,
    );
  }
});
