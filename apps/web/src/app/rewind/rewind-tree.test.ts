import type { ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "@/modules/R0/store";
import { conversationBusy } from "./rewind-tree";

const THREAD = "busy-thread" as ThreadId;

describe("conversationBusy", () => {
  test("an idle chat is not busy", () => {
    expect(conversationBusy(new OmpRuntimeStore({ threadId: THREAD }), false)).toBe(false);
  });

  test("the composer's running flag makes the chat busy while a tool step runs, with no text streaming", () => {
    // Between a tool's start and its end the store holds no streaming reply; only the composer's thread is running.
    expect(conversationBusy(new OmpRuntimeStore({ threadId: THREAD }), true)).toBe(true);
  });

  test("a streaming reply is busy without the composer's flag", () => {
    const store = new OmpRuntimeStore({ threadId: THREAD });
    store.applySessionState({ isStreaming: true });
    expect(conversationBusy(store, false)).toBe(true);
  });
});
