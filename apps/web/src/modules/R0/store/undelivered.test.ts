import type { ChatSessionEvent, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { dialogEvent, uiEvent } from "./session-events";
import { OmpRuntimeStore } from "./store";

const threadId = "thread-undelivered" as ThreadId;

/**
 * Applies one event as the chat's stream does. The cast is the boundary between these literal frames and the typed event
 * union, which the store checks when it reads them.
 */
function apply(store: OmpRuntimeStore, event: unknown, seq: number, replayed = false): void {
  store.ingest(event as ChatSessionEvent, seq, replayed);
}

function notifyFrame(message: string): unknown {
  return uiEvent({ type: "ui_notify", message });
}

function ompNotice(message: string): unknown {
  return { kind: "event", event: { type: "notice", level: "warning", message } };
}

describe("presentation events no listener was attached for", () => {
  test("a notice applied before its listener attaches is given to it, once, as replayed", () => {
    const store = new OmpRuntimeStore({ threadId });
    // A chat's start-up events arrive as its stream opens, before the page subscribes (issue 2181).
    apply(store, notifyFrame("start-up"), 1, true);
    const heard: string[] = [];
    store.subscribeNotifications(["ui_notify"], (frame, seq, replayed) => {
      heard.push(`${seq}:${replayed}:${"message" in frame ? String(frame.message) : frame.type}`);
    });
    expect(heard).toEqual(["1:true:start-up"]);
  });

  test("an event a listener has already taken is not given to a later listener", () => {
    const store = new OmpRuntimeStore({ threadId });
    const first: number[] = [];
    store.subscribeNotifications(["ui_notify"], (_frame, seq) => first.push(seq));
    apply(store, notifyFrame("live"), 1);
    const later: number[] = [];
    store.subscribeNotifications(["ui_notify"], (_frame, seq) => later.push(seq));
    expect(first).toEqual([1]);
    expect(later).toEqual([]);
  });

  test("a dialog is not kept: it waits in the store for its own router, not for a late listener", () => {
    const store = new OmpRuntimeStore({ threadId });
    apply(
      store,
      dialogEvent({ id: "ask-1", method: "ui.confirm", params: { title: "Go on?", message: "" } }),
      1,
    );
    const heard: number[] = [];
    store.subscribeNotifications(["host_dialog"], (_frame, seq) => heard.push(seq));
    expect(heard).toEqual([]);
    expect(store.getSnapshot().pending.dialogs["ask-1"]).toBeDefined();
  });

  test("the oldest are dropped first once more than 200 are waiting", () => {
    const store = new OmpRuntimeStore({ threadId });
    for (let seq = 1; seq <= 210; seq += 1) apply(store, notifyFrame(`n${seq}`), seq, true);
    const heard: number[] = [];
    store.subscribeNotifications(["ui_notify"], (_frame, seq) => heard.push(seq));
    expect(heard).toHaveLength(200);
    expect(heard[0]).toBe(11);
    expect(heard.at(-1)).toBe(210);
  });
});

describe("omp events applied before a listener attaches", () => {
  test("they are given to the first listener, in order, once", () => {
    const store = new OmpRuntimeStore({ threadId });
    apply(store, ompNotice("first"), 1, true);
    apply(store, ompNotice("second"), 2, true);
    const heard: string[] = [];
    store.subscribeOmpEvents(undefined, (event, seq, replayed) => {
      heard.push(`${seq}:${replayed}:${"message" in event ? String(event.message) : event.type}`);
    });
    expect(heard).toEqual(["1:true:first", "2:true:second"]);
  });

  test("an event a listener has already taken is not given to a later listener", () => {
    const store = new OmpRuntimeStore({ threadId });
    const first: number[] = [];
    store.subscribeOmpEvents(undefined, (_event, seq) => first.push(seq));
    apply(store, ompNotice("live"), 1);
    const later: number[] = [];
    store.subscribeOmpEvents(undefined, (_event, seq) => later.push(seq));
    expect(first).toEqual([1]);
    expect(later).toEqual([]);
  });

  test("a typed listener is given its own types, and the rest wait for a listener of theirs", () => {
    const store = new OmpRuntimeStore({ threadId });
    apply(store, ompNotice("notice"), 1, true);
    apply(store, { kind: "event", event: { type: "agent_start" } }, 2, true);
    const starts: number[] = [];
    store.subscribeOmpEvents(["agent_start"], (_event, seq) => starts.push(seq));
    const all: number[] = [];
    store.subscribeOmpEvents(undefined, (_event, seq) => all.push(seq));
    expect(starts).toEqual([2]);
    expect(all).toEqual([1]);
  });
});
