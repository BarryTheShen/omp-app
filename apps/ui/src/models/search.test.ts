import type { SearchEngine } from "@omp-app/contracts/chat-host";
import { describe, expect, test } from "vitest";
import { engineGroups, keylessNote, keyWords, standingOf } from "./search";

function engine(patch: Partial<SearchEngine> & Pick<SearchEngine, "id">): SearchEngine {
  return {
    name: patch.id,
    access: "key",
    keyProvider: patch.id,
    savedKeys: 0,
    ready: false,
    whenPicked: false,
    sharedWithModels: false,
    ...patch,
  };
}

describe("a search engine's standing", () => {
  test("Keenable without a key searches only when picked and is told apart from Keenable with a key", () => {
    const keyless = engine({ id: "keenable", name: "Keenable", whenPicked: true });
    expect(standingOf(keyless)).toBe("picked");
    expect(keylessNote(keyless)).not.toBeNull();
    const keyed = engine({
      id: "keenable",
      name: "Keenable",
      whenPicked: true,
      ready: true,
      key: { from: "saved" },
      savedKeys: 1,
    });
    expect(standingOf(keyed)).toBe("ready");
    expect(keylessNote(keyed)).toBeNull();
    expect(keyWords(keyed)).not.toBe(keyWords(keyless));
  });

  test("an engine without its key needs one; with a key from the environment it names the variable", () => {
    const missing = engine({ id: "tinyfish", name: "TinyFish" });
    expect(standingOf(missing)).toBe("key");
    expect(keylessNote(missing)).toBeNull();
    const fromEnvironment = engine({
      id: "tinyfish",
      ready: true,
      key: { from: "environment", envVar: "TINYFISH_API_KEY" },
    });
    expect(standingOf(fromEnvironment)).toBe("ready");
    expect(keyWords(fromEnvironment)).toContain("TINYFISH_API_KEY");
  });

  test("an engine that signs in names the provider it signs in to", () => {
    const kimi = engine({
      id: "kimi",
      name: "Kimi",
      access: "sign_in",
      keyProvider: "kimi-code",
      keyProviderName: "Kimi Code",
    });
    expect(standingOf(kimi)).toBe("key");
    expect(keyWords(kimi)).toContain("Kimi Code");
  });

  test("an engine that needs no key is ready, searches only when picked, or lacks omp's setting", () => {
    expect(standingOf(engine({ id: "duckduckgo", access: "none", ready: true }))).toBe("ready");
    expect(standingOf(engine({ id: "public", access: "none", whenPicked: true }))).toBe("picked");
    const searxng = engine({ id: "searxng", access: "none" });
    expect(standingOf(searxng)).toBe("setup");
    // No key note for an engine that never takes a key.
    expect(keylessNote(engine({ id: "public", access: "none", whenPicked: true }))).toBeNull();
  });
});

describe("the engine list", () => {
  const engines = [
    engine({ id: "parallel", name: "Parallel", ready: true }),
    engine({ id: "tinyfish", name: "TinyFish" }),
    engine({ id: "keenable", name: "Keenable", whenPicked: true }),
    engine({ id: "searxng", name: "SearXNG", access: "none" }),
    engine({ id: "duckduckgo", name: "DuckDuckGo", access: "none", ready: true }),
  ];

  test("groups the engines in standing order, omp's order within a group, without empty groups", () => {
    expect(
      engineGroups(engines, "").map((group) => [
        group.standing,
        group.engines.map((each) => each.id),
      ]),
    ).toEqual([
      ["ready", ["parallel", "duckduckgo"]],
      ["picked", ["keenable"]],
      ["key", ["tinyfish"]],
      ["setup", ["searxng"]],
    ]);
  });

  test("a search keeps the engines whose name or id holds every word", () => {
    expect(
      engineGroups(engines, "TINY")
        .flatMap((group) => group.engines)
        .map((each) => each.id),
    ).toEqual(["tinyfish"]);
    expect(engineGroups(engines, "duck go").flatMap((group) => group.engines)).toHaveLength(1);
    expect(engineGroups(engines, "nothing like it")).toEqual([]);
  });
});
