import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  clearReadingPlace,
  findMessageRow,
  isViewportAtBottom,
  nextResumeStep,
  type ReadingPlace,
  readStoredReadingPlace,
  saveReadingPlace,
  transcriptCaughtUp,
  whenViewportSettled,
} from "./reading-place";

const place: ReadingPlace = { threadId: "thread-1", messageId: "msg-7", offset: -1240 };
const keyOf = (threadId: string) => `omp.app.reading-place.${threadId}`;

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("reading place storage", () => {
  test("a saved place reads back exactly as it was written", () => {
    saveReadingPlace(place);
    expect(readStoredReadingPlace("thread-1")).toEqual(place);
  });

  test("each chat keeps its own place, and clearing one leaves the others", () => {
    saveReadingPlace(place);
    saveReadingPlace({ threadId: "thread-2", messageId: "msg-9", offset: 12 });
    expect(readStoredReadingPlace("thread-1")).toEqual(place);
    expect(readStoredReadingPlace("thread-2")?.messageId).toBe("msg-9");
    clearReadingPlace("thread-1");
    expect(window.localStorage.getItem(keyOf("thread-1"))).toBeNull();
    expect(readStoredReadingPlace("thread-2")?.messageId).toBe("msg-9");
  });

  test("nothing is read for a chat with no saved place", () => {
    expect(readStoredReadingPlace("thread-1")).toBeNull();
  });

  test("a value that is not JSON, has the wrong shape, or names another chat is ignored", () => {
    window.localStorage.setItem(keyOf("thread-1"), "{not json");
    expect(readStoredReadingPlace("thread-1")).toBeNull();
    window.localStorage.setItem(
      keyOf("thread-1"),
      JSON.stringify({ threadId: "thread-1", messageId: "", offset: 3 }),
    );
    expect(readStoredReadingPlace("thread-1")).toBeNull();
    window.localStorage.setItem(
      keyOf("thread-1"),
      JSON.stringify({ threadId: "thread-1", messageId: "m", offset: "3" }),
    );
    expect(readStoredReadingPlace("thread-1")).toBeNull();
    window.localStorage.setItem(
      keyOf("thread-1"),
      JSON.stringify({ ...place, threadId: "thread-2" }),
    );
    expect(readStoredReadingPlace("thread-1")).toBeNull();
  });

  test("a provisional streaming id is never read back, since it does not exist after a reload", () => {
    window.localStorage.setItem(
      keyOf("thread-1"),
      JSON.stringify({ ...place, messageId: "stream:abc" }),
    );
    expect(readStoredReadingPlace("thread-1")).toBeNull();
  });
});

describe("nextResumeStep", () => {
  const idle = {
    historyLoading: false,
    rowLoaded: false,
    canLoadOlder: false,
    pageInFlight: false,
  };

  test("waits while the history is still loading, even when the saved message is already shown", () => {
    expect(nextResumeStep({ ...idle, historyLoading: true, rowLoaded: true })).toBe("wait");
    expect(nextResumeStep({ ...idle, historyLoading: true, canLoadOlder: true })).toBe("wait");
  });

  test("places the reader once the saved message is on screen", () => {
    expect(nextResumeStep({ ...idle, rowLoaded: true, canLoadOlder: true })).toBe("restore");
  });

  test("pages older history while the saved message is not loaded and older history exists", () => {
    expect(nextResumeStep({ ...idle, canLoadOlder: true })).toBe("load-older");
  });

  test("waits for an older page already being read rather than starting another", () => {
    expect(nextResumeStep({ ...idle, canLoadOlder: true, pageInFlight: true })).toBe("wait");
  });

  test("opens at the newest message when the saved message cannot be found", () => {
    expect(nextResumeStep(idle)).toBe("bottom");
  });
});

describe("findMessageRow", () => {
  test("finds a row by its message id inside the viewport only", () => {
    const viewport = document.createElement("div");
    const inside = document.createElement("div");
    inside.dataset.messageId = "msg-7";
    viewport.append(inside);
    const outside = document.createElement("div");
    outside.dataset.messageId = "msg-8";
    document.body.append(outside);

    expect(findMessageRow(viewport, "msg-7")).toBe(inside);
    expect(findMessageRow(viewport, "msg-8")).toBeNull();
    expect(findMessageRow(viewport, "missing")).toBeNull();
  });

  test("finds a streamed row by its store key, not by the id assistant-ui writes on it (issue 1047)", () => {
    const viewport = document.createElement("div");
    const streamed = document.createElement("div");
    streamed.dataset.messageId = "stream:t:0:m1";
    streamed.dataset.storeKey = "entry:t:e1";
    viewport.append(streamed);
    const summary = document.createElement("div");
    summary.dataset.messageId = "entry:t:b1";
    viewport.append(summary);

    expect(findMessageRow(viewport, "entry:t:e1")).toBe(streamed);
    expect(findMessageRow(viewport, "stream:t:0:m1")).toBeNull();
    expect(findMessageRow(viewport, "entry:t:b1")).toBe(summary);
  });
});

describe("transcriptCaughtUp", () => {
  function transcriptWith(...ids: string[]): HTMLElement {
    const viewport = document.createElement("div");
    for (const id of ids) {
      const row = document.createElement("div");
      row.dataset.messageId = id;
      viewport.append(row);
    }
    return viewport;
  }

  test("holds once the oldest and the newest messages are drawn", () => {
    expect(transcriptCaughtUp(transcriptWith("a", "b", "c"), ["a", "b", "c"])).toBe(true);
  });

  test("does not hold while the newest message is not drawn yet", () => {
    expect(transcriptCaughtUp(transcriptWith("a", "b"), ["a", "b", "c"])).toBe(false);
  });

  test("does not hold while the oldest message is not drawn yet", () => {
    expect(transcriptCaughtUp(transcriptWith("b", "c"), ["a", "b", "c"])).toBe(false);
  });

  test("holds for an empty store", () => {
    expect(transcriptCaughtUp(transcriptWith(), [])).toBe(true);
  });
});

describe("isViewportAtBottom", () => {
  function viewport(scrollTop: number, scrollHeight: number, clientHeight: number): HTMLElement {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      scrollTop: { value: scrollTop, configurable: true },
      scrollHeight: { value: scrollHeight, configurable: true },
      clientHeight: { value: clientHeight, configurable: true },
    });
    return element;
  }

  test("counts the end of the transcript, within a pixel, as the bottom", () => {
    expect(isViewportAtBottom(viewport(2_000, 2_600, 600))).toBe(true);
    expect(isViewportAtBottom(viewport(1_999, 2_600, 600))).toBe(true);
  });

  test("a reader scrolled further up than a pixel is not at the bottom", () => {
    expect(isViewportAtBottom(viewport(1_998, 2_600, 600))).toBe(false);
    expect(isViewportAtBottom(viewport(1_246, 3_114, 612))).toBe(false);
  });

  test("a transcript shorter than the viewport has nothing to scroll, so it is at the bottom", () => {
    expect(isViewportAtBottom(viewport(0, 300, 600))).toBe(true);
  });
});

describe("whenViewportSettled", () => {
  test("calls back once the viewport is quiet for two frames and the transcript has caught up", async () => {
    const viewport = document.createElement("div");
    document.body.append(viewport);
    let calls = 0;
    whenViewportSettled(
      viewport,
      () => true,
      () => {
        calls += 1;
      },
    );
    await waitFor(() => expect(calls).toBe(1));
    viewport.remove();
  });

  test("keeps waiting while the transcript has not caught up, even when the viewport is quiet", async () => {
    const viewport = document.createElement("div");
    document.body.append(viewport);
    let caughtUp = false;
    let checks = 0;
    let calls = 0;
    whenViewportSettled(
      viewport,
      () => {
        checks += 1;
        return caughtUp;
      },
      () => {
        calls += 1;
      },
    );
    // Several quiet frames pass, each asking whether the transcript has caught up: none may decide yet.
    await waitFor(() => expect(checks).toBeGreaterThanOrEqual(3));
    expect(calls).toBe(0);
    caughtUp = true;
    await waitFor(() => expect(calls).toBe(1));
    viewport.remove();
  });

  test("keeps waiting while the viewport keeps changing, so a row about to be drawn is not missed", async () => {
    const viewport = document.createElement("div");
    document.body.append(viewport);
    let changes = 0;
    const change = (): void => {
      if (changes >= 5) return;
      changes += 1;
      viewport.append(document.createElement("div"));
      requestAnimationFrame(change);
    };
    change();
    let changesWhenDone = -1;
    whenViewportSettled(
      viewport,
      () => true,
      () => {
        changesWhenDone = changes;
      },
    );
    await waitFor(() => expect(changesWhenDone).toBeGreaterThanOrEqual(0));
    expect(changesWhenDone).toBe(5);
    viewport.remove();
  });

  test("decides after a bounded number of frames even if the transcript never catches up", async () => {
    const viewport = document.createElement("div");
    document.body.append(viewport);
    let calls = 0;
    whenViewportSettled(
      viewport,
      () => false,
      () => {
        calls += 1;
      },
    );
    await waitFor(() => expect(calls).toBe(1), { timeout: 5_000 });
    viewport.remove();
  });

  test("cancelling stops the wait", async () => {
    const viewport = document.createElement("div");
    document.body.append(viewport);
    let calls = 0;
    const cancel = whenViewportSettled(
      viewport,
      () => true,
      () => {
        calls += 1;
      },
    );
    cancel();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(calls).toBe(0);
    viewport.remove();
  });
});
