import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { type ChatHistory, readWholeChat } from "./whole-chat";

interface FakeHistory extends ChatHistory<string> {
  /** How many pages were asked for. */
  readonly loads: () => number;
}

/**
 * A chat the store shows from its newest page. Each loadOlder adds the nearest older page back, as the runtime
 * store does. `stuck` makes a page add nothing; `fail` makes loading reject with that value.
 */
function pagedHistory(
  shown: readonly string[],
  olderPages: readonly (readonly string[])[],
  options: { readonly stuck?: boolean; readonly fail?: unknown } = {},
): FakeHistory {
  let messages = [...shown];
  const pending = olderPages.map((page) => [...page]);
  let loads = 0;
  return {
    messages: () => messages,
    loadedEntries: () => messages.length,
    hasOlder: () => pending.length > 0,
    loadOlder: () => {
      loads += 1;
      if (options.fail !== undefined) return Promise.reject(options.fail);
      if (options.stuck !== true) messages = [...(pending.shift() ?? []), ...messages];
      return Promise.resolve();
    },
    loads: () => loads,
  };
}

async function failureOf(run: () => Promise<unknown>): Promise<AppFailure> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppFailure) return error;
    throw error;
  }
  throw new Error("the read resolved where a failure was expected");
}

describe("readWholeChat", () => {
  test("a chat shown in full is returned as it is, with no page loaded", async () => {
    const history = pagedHistory(["a", "b"], []);
    expect(await readWholeChat(history)).toEqual(["a", "b"]);
    expect(history.loads()).toBe(0);
  });

  test("every older page loads before the chat is returned, so the oldest message comes first", async () => {
    const history = pagedHistory(["d", "e"], [["c"], ["a", "b"]]);
    expect(await readWholeChat(history)).toEqual(["a", "b", "c", "d", "e"]);
    expect(history.loads()).toBe(2);
  });

  test("a page that adds nothing while older history remains stops the export, with no loop", async () => {
    const history = pagedHistory(["d"], [["c"]], { stuck: true });
    const failure = await failureOf(() => readWholeChat(history));
    expect(failure.appError).toMatchObject({
      code: "internal",
      message: "omp did not return the older part of this chat, so nothing was exported.",
    });
    expect(history.loads()).toBe(1);
  });

  test("a typed failure from loading a page reaches the person as it is", async () => {
    const typed = new AppFailure({
      code: "unavailable",
      message: "The session file is busy.",
      retryable: true,
    });
    const failure = await failureOf(() =>
      readWholeChat(pagedHistory(["d"], [["c"]], { fail: typed })),
    );
    expect(failure.appError).toMatchObject({
      code: "unavailable",
      message: "The session file is busy.",
    });
  });

  test("any other failure while loading a page becomes a plain internal failure", async () => {
    const failure = await failureOf(() =>
      readWholeChat(pagedHistory(["d"], [["c"]], { fail: new Error("socket closed") })),
    );
    expect(failure.appError).toMatchObject({
      code: "internal",
      message: "The older part of this chat could not be read, so nothing was exported.",
    });
  });

  test("a cancelled export starts no page", async () => {
    const controller = new AbortController();
    controller.abort();
    const history = pagedHistory(["b"], [["a"]]);
    const failure = await failureOf(() => readWholeChat(history, controller.signal));
    expect(failure.appError.code).toBe("cancelled");
    expect(history.loads()).toBe(0);
  });
});
