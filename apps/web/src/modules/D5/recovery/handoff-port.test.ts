import { AppFailure, type ChatSessionClient, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import realHandoff from "./fixtures/real-handoff.json";
import { createHandoffPort, handoffResultOf } from "./handoff-port";

const threadId = ThreadId.parse("thread-d54-port");

function recordingSession(answer: () => Promise<unknown>) {
  const sent: unknown[] = [];
  const session = {
    request: (args: unknown) => {
      sent.push(args);
      return answer();
    },
  } as unknown as Pick<ChatSessionClient, "request">;
  return { sent, session };
}

describe("handoffResultOf", () => {
  test("reads omp's real successful answer, which carries no saved path, as a settled handoff without one", () => {
    expect(realHandoff.handoff.rpcAnswerOnSuccess).toEqual({});
    expect(handoffResultOf(realHandoff.handoff.rpcAnswerOnSuccess)).toEqual({
      savedPath: null,
      summaryEntryId: null,
      sessionSettled: true,
    });
  });

  test("keeps an absolute session file path that the contract accepts", () => {
    expect(handoffResultOf({ savedPath: "/sessions/handoff.jsonl" }).savedPath).toBe(
      "/sessions/handoff.jsonl",
    );
  });

  test("does not report a path the contract rejects: an automatic handoff is written as .md, and a relative path is not a session file", () => {
    expect(handoffResultOf({ savedPath: "/sessions/handoff-2026-10-14.md" }).savedPath).toBeNull();
    expect(handoffResultOf({ savedPath: "sessions/handoff.jsonl" }).savedPath).toBeNull();
  });

  test("treats omp's null answer, which means no handoff was made, as a failure and not a success", () => {
    expect(() => handoffResultOf(null)).toThrow(AppFailure);
    expect(() => handoffResultOf(null)).toThrow("No handoff was made.");
  });
});

describe("createHandoffPort", () => {
  test("asks the host for a handoff of the open thread, with the focus only when the person gave some", async () => {
    const recorded = recordingSession(() => Promise.resolve({}));
    const port = createHandoffPort(recorded.session, () => threadId);

    await port.createHandoff();
    await port.createHandoff({ customInstructions: "   " });
    await port.createHandoff({ customInstructions: "  Keep the test plan.  " });

    expect(recorded.sent).toEqual([
      { threadId, method: "handoff", params: {} },
      { threadId, method: "handoff", params: {} },
      { threadId, method: "handoff", params: { customInstructions: "Keep the test plan." } },
    ]);
  });

  test("reads the thread id at the call, so a later session is the one handed off", async () => {
    const recorded = recordingSession(() => Promise.resolve(null));
    let current = threadId;
    const port = createHandoffPort(recorded.session, () => current);
    current = ThreadId.parse("thread-d54-later");

    await expect(port.createHandoff()).rejects.toThrow("No handoff was made.");
    expect(recorded.sent).toEqual([
      { threadId: ThreadId.parse("thread-d54-later"), method: "handoff", params: {} },
    ]);
  });

  test("passes omp's refusal through as the send's own failure, unchanged", async () => {
    const refusal = realHandoff.handoff.rpcRefusalNothingToHandOff.replace(/^AppFailure: /, "");
    const failure = new AppFailure({ code: "omp_error", message: refusal, retryable: false });
    const recorded = recordingSession(() => Promise.reject(failure));
    const port = createHandoffPort(recorded.session, () => threadId);

    await expect(port.createHandoff()).rejects.toBe(failure);
    expect(refusal).toBe("Nothing to hand off (already compacted)");
  });
});
