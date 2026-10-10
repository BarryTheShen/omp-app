import type { EntryId, OmpWire, RpcSessionSend, ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "../store/store";
import { createOmpBranchingController } from "./branching";

const sourceThread = "source-thread" as ThreadId;
const branchedThread = "branched-thread" as ThreadId;
const userEntry = "user-entry" as EntryId;
const calls: Array<{
  readonly type: string;
  readonly command: unknown;
  readonly threadId?: ThreadId;
}> = [];

function userEntryRecord(content: string): Record<string, unknown> {
  return {
    type: "message",
    id: userEntry,
    parentId: null,
    timestamp: "2026-10-05T00:00:00.000Z",
    message: { role: "user", content, timestamp: 1 },
  };
}

function storeWithUserEntry(): OmpRuntimeStore {
  const store = new OmpRuntimeStore({ threadId: sourceThread });
  store.pairEndedMessages([userEntryRecord("original draft")], userEntry);
  return store;
}

/** omp's answers to the two commands a branch sends. Any other command, a rename included, throws here. */
function sendFor(
  branchResult: OmpWire.BranchResult | AppFailure = { text: "original draft", cancelled: false },
): RpcSessionSend {
  return (async (args) => {
    calls.push({ type: args.command.type, command: args.command, threadId: args.threadId });
    if (args.command.type === "branch") {
      if (branchResult instanceof AppFailure) throw branchResult;
      return branchResult;
    }
    if (args.command.type === "get_state") return { sessionId: branchedThread };
    throw new Error(`unexpected command ${args.command.type}`);
  }) as RpcSessionSend;
}

describe("OmpBranchingController", () => {
  test("edit creates a branch, switches to omp's reported thread, reloads, then submits through R0.3", async () => {
    const store = storeWithUserEntry();
    calls.length = 0;
    const switched: ThreadId[] = [];
    const reloaded: boolean[] = [];
    const submitted: unknown[] = [];
    const controller = createOmpBranchingController({
      store,
      send: sendFor(),
      submitPrompt: async (intent) => {
        submitted.push(intent);
      },
      switchThread: async (threadId) => {
        switched.push(threadId);
      },
      reloadHistory: async () => {
        reloaded.push(true);
      },
    });

    await controller.editFrom(userEntry, {
      mode: "prompt",
      text: "edited draft",
      delivery: "followUp",
    });

    expect(calls.map((call) => call.type)).toEqual(["branch", "get_state"]);
    expect(switched).toEqual([branchedThread]);
    expect(reloaded).toEqual([true]);
    expect(submitted).toEqual([{ mode: "prompt", text: "edited draft", delivery: "new" }]);
    expect(store.getSnapshot().transcript.entries[userEntry]).toBeDefined();
  });

  test("regenerate reads the source user entry and submits the same text", async () => {
    const store = storeWithUserEntry();
    const submitted: unknown[] = [];
    const controller = createOmpBranchingController({
      store,
      send: sendFor(),
      submitPrompt: async (intent) => {
        submitted.push(intent);
      },
      switchThread: async () => {},
      reloadHistory: async () => {},
    });

    await controller.regenerateFrom(userEntry);

    expect(submitted).toEqual([{ mode: "prompt", text: "original draft", delivery: "new" }]);
  });

  test("branch failure keeps the source entry and does not submit a second prompt", async () => {
    const store = storeWithUserEntry();
    let submitted = false;
    const controller = createOmpBranchingController({
      store,
      send: sendFor(new AppFailure({ code: "conflict", message: "busy", retryable: true })),
      submitPrompt: async () => {
        submitted = true;
      },
      switchThread: async () => {},
      reloadHistory: async () => {},
    });

    await expect(
      controller.editFrom(userEntry, { mode: "prompt", text: "kept draft", delivery: "new" }),
    ).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(submitted).toBe(false);
    expect(store.getSnapshot().transcript.entries[userEntry]).toBeDefined();
  });

  test("submit failure keeps the source transcript and exact edit intent for draft recovery", async () => {
    const store = storeWithUserEntry();
    const intent = { mode: "prompt" as const, text: "failed edit", delivery: "new" as const };
    const controller = createOmpBranchingController({
      store,
      send: sendFor(),
      submitPrompt: async () => {
        throw new AppFailure({ code: "omp_error", message: "admission failed", retryable: true });
      },
      switchThread: async () => {},
      reloadHistory: async () => {},
    });

    await expect(controller.editFrom(userEntry, intent)).rejects.toMatchObject({
      appError: { code: "omp_error" },
    });
    expect(intent).toEqual({ mode: "prompt", text: "failed edit", delivery: "new" });
    expect(store.getSnapshot().transcript.entries[userEntry]).toBeDefined();
  });

  test("switches back to the original branch through the selected-thread seam", async () => {
    const store = storeWithUserEntry();
    const switched: ThreadId[] = [];
    const controller = createOmpBranchingController({
      store,
      send: sendFor(),
      submitPrompt: async () => {},
      switchThread: async (threadId) => {
        switched.push(threadId);
      },
      reloadHistory: async () => {},
    });

    await controller.switchTo(sourceThread);
    expect(switched).toEqual([sourceThread]);
  });

  test("stale entry ids return not_found and other branches are read-only", () => {
    const store = storeWithUserEntry();
    const controller = createOmpBranchingController({
      store,
      send: sendFor(),
      submitPrompt: async () => {},
      switchThread: async () => {},
      reloadHistory: async () => {},
    });

    expect(controller.readOnlyBranch(userEntry)).toMatchObject({
      readOnly: true,
      entryId: userEntry,
      headId: userEntry,
    });
    try {
      controller.readOnlyBranch("missing" as EntryId);
      throw new Error("expected not_found");
    } catch (error) {
      expect(error).toMatchObject({ appError: { code: "not_found" } });
    }
  });

  test("regenerate asks again on a new chat and sends no rename, so the chat keeps the name omp gave it", async () => {
    const store = storeWithUserEntry();
    calls.length = 0;
    const controller = createOmpBranchingController({
      store,
      send: sendFor(),
      submitPrompt: async (intent) => {
        calls.push({ type: "submit", command: intent });
      },
      switchThread: async () => {},
      reloadHistory: async () => {},
    });

    await controller.regenerateFrom(userEntry);

    expect(calls.map((call) => call.type)).toEqual(["branch", "get_state", "submit"]);
    expect(calls.find((call) => call.type === "submit")?.command).toMatchObject({
      text: "original draft",
      delivery: "new",
    });
  });

  test("regenerating three times names no chat, so every branch keeps the title omp gave it", async () => {
    const store = storeWithUserEntry();
    calls.length = 0;
    const controller = createOmpBranchingController({
      store,
      send: sendFor(),
      submitPrompt: async (intent) => {
        calls.push({ type: "submit", command: intent });
      },
      switchThread: async () => {},
      reloadHistory: async () => {},
    });

    for (let round = 0; round < 3; round += 1) await controller.regenerateFrom(userEntry);

    expect(calls.filter((call) => call.type === "submit")).toHaveLength(3);
    expect(calls.some((call) => call.type === "set_session_name")).toBe(false);
  });

  test("edit sends no rename, so the branch keeps the name omp gave it", async () => {
    const store = storeWithUserEntry();
    calls.length = 0;
    const controller = createOmpBranchingController({
      store,
      send: sendFor(),
      submitPrompt: async () => {},
      switchThread: async () => {},
      reloadHistory: async () => {},
    });

    await controller.editFrom(userEntry, { mode: "prompt", text: "edited draft", delivery: "new" });

    expect(calls.map((call) => call.type)).toEqual(["branch", "get_state"]);
  });
});
