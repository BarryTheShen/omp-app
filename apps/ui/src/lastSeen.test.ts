import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/** This browser's storage as the tests see it; `refuse` makes every write fail, as a full or blocked storage does. */
function storage(refuse = false) {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (refuse) throw new Error("QuotaExceededError");
      items.set(key, value);
    },
  };
}

/** The module as a page loads it: a fresh import is a reload, with nothing kept in memory. */
async function load() {
  vi.resetModules();
  return (await import("./lastSeen")).lastSeen;
}

const numbers = (stored: unknown) =>
  Array.isArray(stored) && stored.every((each) => typeof each === "number")
    ? (stored as number[])
    : undefined;

describe("lastSeen", () => {
  beforeEach(() => vi.stubGlobal("localStorage", storage()));
  afterEach(() => vi.unstubAllGlobals());

  test("a value kept with a check is there after a reload; one storage holds that fails its check is not", async () => {
    (await load())("models", numbers).set([1, 2, 3]);
    const reloaded = await load();
    expect(reloaded("models", numbers).get()).toEqual([1, 2, 3]);

    localStorage.setItem("omp-app.ui.last.models", JSON.stringify(["written by an older app"]));
    expect((await load())("models", numbers).get()).toBeUndefined();
    localStorage.setItem("omp-app.ui.last.models", "{not json");
    expect((await load())("models", numbers).get()).toBeUndefined();
  });

  test("a value kept without a check stays in the page only", async () => {
    const lastSeen = await load();
    lastSeen<string>("hub").set("roles");
    expect(lastSeen<string>("hub").get()).toBe("roles");
    expect(localStorage.getItem("omp-app.ui.last.hub")).toBeNull();
    expect((await load())<string>("hub").get()).toBeUndefined();
  });

  test("a storage that refuses the write leaves the value in the page", async () => {
    vi.stubGlobal("localStorage", storage(true));
    const lastSeen = await load();
    lastSeen("models", numbers).set([4]);
    expect(lastSeen("models", numbers).get()).toEqual([4]);
  });
});
