import { type AttachmentRef, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { DraftSnapshot } from "../../U2/drafts/drafts";
import { type ComposerDraftController, composerDraftOf, reviewedGoalText } from "./composer";

const image: AttachmentRef = {
  id: "image-1",
  name: "shot.png",
  mediaType: "image/png",
  sizeBytes: 3,
};

function snapshotOf(text: string): DraftSnapshot {
  return {
    scope: { kind: "thread", threadId: ThreadId.parse("thread-chat") },
    status: "idle",
    text,
    attachments: [image],
    failedSends: [],
    revision: null,
    dirty: false,
    replaced: null,
    conflict: null,
    error: null,
  };
}

/** A draft controller stand-in that records what it was asked to hold and whether it was saved. */
function fakeController(text: string) {
  const calls: string[] = [];
  let snapshot = snapshotOf(text);
  const controller: ComposerDraftController = {
    getSnapshot: () => snapshot,
    setDraft: (next, attachments) => {
      calls.push(`setDraft:${next}:${attachments.length}`);
      snapshot = { ...snapshot, text: next };
    },
    flush: async () => {
      calls.push("flush");
    },
  };
  return { controller, calls };
}

describe("composerDraftOf", () => {
  test("reads the text of the chat's controller and writes the goal text back, keeping its attachments, then saves", async () => {
    const chat = fakeController("typed");
    const sink = composerDraftOf(() => chat.controller);

    expect(sink.read()).toBe("typed");
    await sink.write("Ship");

    expect(chat.calls).toEqual(["setDraft:Ship:1", "flush"]);
    expect(sink.read()).toBe("Ship");
  });

  test("reads and writes the controller that holds the chat's draft at each call, not the one held earlier", async () => {
    // useChatDraft replaces its controller when the draft's scope changes; a sink made earlier must follow it.
    const before = fakeController("before");
    const after = fakeController("after");
    let holder = before.controller;
    const sink = composerDraftOf(() => holder);

    expect(sink.read()).toBe("before");
    holder = after.controller;
    expect(sink.read()).toBe("after");
    await sink.write("written");

    expect(before.calls).toEqual([]);
    expect(after.calls).toEqual(["setDraft:written:1", "flush"]);
  });
});

describe("reviewedGoalText", () => {
  test("is the objective alone when there is no token budget", () => {
    expect(reviewedGoalText({ objective: "## Objective\nShip", tokenBudget: undefined })).toBe(
      "## Objective\nShip",
    );
  });

  test("adds the token budget as its own line", () => {
    expect(reviewedGoalText({ objective: "Ship", tokenBudget: 5000 })).toBe(
      "Ship\n\nToken budget: 5000 tokens",
    );
  });
});
