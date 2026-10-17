import { ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { createP3RunStatus, type P3RunState } from "./status";
import { sourceThread, userEntry } from "./test-support";

const record = {
  kind: "edit" as const,
  sourceEntryId: userEntry,
  sourceThreadId: sourceThread,
  replacement: { text: "Explain again", images: [] },
};

const sending: P3RunState = { ...record, phase: "sending" };

const sent: P3RunState = {
  ...record,
  phase: "sent",
  threadId: ThreadIdSchema.parse("branch-of-source"),
  settled: true,
  workspaceGuarantee: "not-managed",
  externalChanges: [],
  partialFailure: null,
};

const failed: P3RunState = {
  ...record,
  phase: "failed",
  branched: false,
  chatThreadId: sourceThread,
  message: "omp is busy",
  retryable: true,
};

describe("P3 run status", () => {
  test("dismissing a finished run's notice returns the status to idle and tells its listeners", () => {
    const status = createP3RunStatus();
    status.set(sent);
    const listener = vi.fn();
    status.subscribe(listener);
    status.dismiss();
    expect(status.getSnapshot()).toEqual({ phase: "idle" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("dismissing a failed run ends it, so nothing offers Try again for it any more", () => {
    const status = createP3RunStatus();
    status.set(failed);
    status.dismiss();
    expect(status.getSnapshot()).toEqual({ phase: "idle" });
  });

  test("dismissing a run that is still sending changes nothing and tells no one", () => {
    const status = createP3RunStatus();
    status.set(sending);
    const listener = vi.fn();
    status.subscribe(listener);
    status.dismiss();
    expect(status.getSnapshot()).toBe(sending);
    expect(listener).not.toHaveBeenCalled();
  });
});
