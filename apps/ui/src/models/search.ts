import type { SearchEngine, SearchTest } from "@omp-app/contracts/chat-host";

/**
 * Where an engine stands with omp (#11, #12), as omp's provider menu sorts providers: omp searches with it in its
 * automatic order (`ready`), only when it is picked by name (`picked`, Keenable or Perplexity without a key), it needs a
 * key or a sign-in first (`key`), or omp lacks a setting it needs (`setup`, SearXNG without its address).
 */
export type EngineStanding = "ready" | "picked" | "key" | "setup";

export function standingOf(engine: SearchEngine): EngineStanding {
  if (engine.ready) return "ready";
  if (engine.whenPicked) return "picked";
  return engine.access === "none" ? "setup" : "key";
}

/** The engine list's groups, in order. */
export const STANDING_TITLES: Readonly<Record<EngineStanding, string>> = {
  ready: "Ready",
  picked: "Only when picked",
  key: "Need a key or sign-in",
  setup: "Not set up",
};

const STANDINGS: readonly EngineStanding[] = ["ready", "picked", "key", "setup"];

/** Where an engine's key comes from, or what it lacks, in a few words for its row. */
export function keyWords(engine: SearchEngine): string {
  const { key } = engine;
  if (key !== undefined) {
    switch (key.from) {
      case "saved":
        return "Key saved";
      case "signed_in":
        return engine.keyProviderName === undefined
          ? "Signed in"
          : `Signed in to ${engine.keyProviderName}`;
      case "environment":
        return key.envVar === undefined
          ? "Key from the server's environment"
          : `Key from ${key.envVar}`;
      case "config":
        return "Key from omp's models.yml";
      case "runtime":
        return "Key from omp's --api-key";
    }
  }
  if (engine.access === "none") {
    if (engine.ready) return "No key needed";
    if (engine.whenPicked) return "No key needed; searches only when picked";
    return engine.id === "searxng"
      ? "Needs SearXNG's address in omp's settings"
      : "Not set up in omp";
  }
  if (engine.ready) return "Works without a key";
  if (engine.whenPicked) return "No key: searches only when picked";
  return engine.access === "sign_in"
    ? `Needs a ${engine.keyProviderName ?? engine.name} sign-in`
    : "Needs a key";
}

/**
 * What an engine that searches without a key does differently with one (Keenable, Perplexity): told apart, so a
 * keyless search is never taken for the engine with a key.
 */
export function keylessNote(engine: SearchEngine): string | null {
  if (engine.access === "none" || engine.key !== undefined || engine.ready || !engine.whenPicked) {
    return null;
  }
  return `Without a key, omp searches with ${engine.name} only when it is picked by name. With a key, omp also tries it in its automatic order.`;
}

/** Whether an engine's name or id holds every word of a search. */
function matches(engine: SearchEngine, query: string): boolean {
  const text = `${engine.name} ${engine.id}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .every((word) => text.includes(word));
}

/** The engines matching a search, in omp's order within groups in standing order; empty groups are left out. */
export function engineGroups(
  engines: readonly SearchEngine[],
  query: string,
): readonly {
  readonly standing: EngineStanding;
  readonly title: string;
  readonly engines: readonly SearchEngine[];
}[] {
  const found = engines.filter((engine) => matches(engine, query));
  return STANDINGS.map((standing) => ({
    standing,
    title: STANDING_TITLES[standing],
    engines: found.filter((engine) => standingOf(engine) === standing),
  })).filter((group) => group.engines.length > 0);
}

/** A test search's result in words: how many results and how long, or omp's words for what failed. */
export function testWords(result: SearchTest): string {
  const seconds = `${(result.ms / 1_000).toFixed(1)} s`;
  if (!result.ok) return `Search failed: ${result.message}`;
  return result.results === 1
    ? `Works: 1 result in ${seconds}.`
    : `Works: ${result.results} results in ${seconds}.`;
}
