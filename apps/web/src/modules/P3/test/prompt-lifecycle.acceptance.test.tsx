// The completed, aborted and provider-error prompt results and session_settled are recorded (R0's `prompt-stream` and
// `abort`, P3's `p3-provider-error`); the pending result is written in the host's shape (`PromptResultEvent`,
// packages/contracts/src/chat-host/protocol.ts).
import type { ChatSessionEvent, Omp } from "@omp-app/contracts";
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "@/modules/R0/store";
import { ompEvent } from "@/modules/R0/store/session-events";
import {
  BRANCHED_CHAT,
  promptAborted,
  promptCompleted,
  promptErrorRecorded,
  promptPending,
  SESSION_SETTLED,
  SOURCE_CHAT,
  USER_WITH_IMAGE,
} from "../fixtures/omp-branch";
import { editAppend, renderRun } from "./run-harness";

afterEach(cleanup);

function receiveOmp(store: OmpRuntimeStore, event: unknown, seq: number): void {
  store.ingest(ompEvent(event as Omp.SessionEvent), seq);
}

describe("acceptance: a prompt's result and the session's settling are separate facts", () => {
  test("agent_end then prompt_result leaves background work unsettled until session_settled", () => {
    const store = new OmpRuntimeStore({ threadId: SOURCE_CHAT });
    receiveOmp(store, { type: "agent_start" }, 1);
    receiveOmp(store, { type: "agent_end" }, 2);

    store.ingest(promptPending("req-1"), 3);
    expect(store.getSnapshot().prompt).toMatchObject({
      admitted: true,
      sessionSettled: false,
      promptResult: { status: "completed", sessionSettled: false },
    });

    store.ingest(SESSION_SETTLED, 4);
    expect(store.getSnapshot().prompt).toMatchObject({ sessionSettled: true, streaming: false });
  });

  test("the recorded completed turn is admitted, and its result says the session is settled", () => {
    const store = new OmpRuntimeStore({ threadId: SOURCE_CHAT });

    store.ingest(promptCompleted(), 1);

    expect(store.getSnapshot().prompt).toMatchObject({
      admitted: true,
      streaming: false,
      promptResult: { status: "completed", sessionSettled: true },
    });
    expect(store.getSnapshot().error).toBeNull();
  });

  test("the recorded aborted turn is an aborted prompt, and it shows no error", () => {
    const store = new OmpRuntimeStore({ threadId: SOURCE_CHAT });

    store.ingest(promptAborted(), 1);

    expect(store.getSnapshot().prompt.promptResult).toMatchObject({ status: "aborted" });
    expect(store.getSnapshot().error).toBeNull();
  });

  test("a prompt_result error is an omp_error carrying the frame's message and retryable flag", () => {
    const store = new OmpRuntimeStore({ threadId: SOURCE_CHAT });

    store.ingest(promptErrorRecorded(), 1);

    expect(store.getSnapshot().error).toMatchObject({
      code: "omp_error",
      message:
        "503 fake provider retry failure\nfake provider retry failure (type=server_error param=service_unavailable)",
      retryable: true,
    });
  });

  test("the edit notice stays pending after prompt_result and settles on session_settled", async () => {
    const run = renderRun();

    await act(async () => {
      await run.handlers.onEdit(editAppend(String(USER_WITH_IMAGE), "Explain again"));
    });
    const branchStore = run.stores.get(String(BRANCHED_CHAT));
    if (!branchStore) throw new Error("the branched chat store was not created");
    branchStore.applySessionState({ isSettled: true });
    expect(run.runs.status.getSnapshot()).toMatchObject({
      phase: "sent",
      threadId: BRANCHED_CHAT,
      settled: false,
    });
    await act(async () => {
      receiveOmp(branchStore, { type: "agent_start" }, 1);
      receiveOmp(branchStore, { type: "agent_end" }, 2);
      branchStore.ingest(promptPending("req-3"), 3);
    });
    expect(branchStore.getSnapshot().prompt).toMatchObject({
      sessionSettled: false,
      promptResult: { sessionSettled: false },
    });
    expect(run.runs.status.getSnapshot()).toMatchObject({
      phase: "sent",
      threadId: BRANCHED_CHAT,
      settled: false,
    });

    await act(async () => branchStore.ingest(SESSION_SETTLED, 4));
    expect(run.runs.status.getSnapshot()).toMatchObject({
      phase: "sent",
      threadId: BRANCHED_CHAT,
      settled: true,
    });
  });

  test("an omp exit before the response leaves the sent notice pending", async () => {
    const run = renderRun();
    await act(async () => {
      await run.handlers.onEdit(editAppend(String(USER_WITH_IMAGE), "Explain again"));
    });
    const branchStore = run.stores.get(String(BRANCHED_CHAT));
    if (!branchStore) throw new Error("the branched chat store was not created");

    await act(async () => {
      branchStore.ingest({ kind: "process", status: "exited" } as ChatSessionEvent, 1);
    });
    expect(branchStore.getSnapshot().process.status).toBe("exited");
    expect(run.runs.status.getSnapshot()).toMatchObject({
      phase: "sent",
      threadId: BRANCHED_CHAT,
      settled: false,
    });
  });

  test("a settled state from the original chat cannot settle the branched run", async () => {
    const run = renderRun();
    await act(async () => {
      await run.handlers.onEdit(editAppend(String(USER_WITH_IMAGE), "Explain again"));
    });
    const branchStore = run.stores.get(String(BRANCHED_CHAT));
    if (!branchStore) throw new Error("the branched chat store was not created");

    await run.open(SOURCE_CHAT);
    const originalStore = run.stores.get(String(SOURCE_CHAT));
    if (!originalStore) throw new Error("the original chat store was not created");
    await act(async () => {
      originalStore.applySessionState({ isSettled: true });
      receiveOmp(originalStore, { type: "agent_start" }, 1);
      receiveOmp(originalStore, { type: "agent_end" }, 2);
      originalStore.ingest(promptPending("req-wrong-store"), 3);
      originalStore.ingest(SESSION_SETTLED, 4);
    });
    expect(run.runs.status.getSnapshot()).toMatchObject({
      phase: "sent",
      threadId: BRANCHED_CHAT,
      settled: false,
    });
  });

  test("an omp exit after the prompt was admitted settles the sent notice", async () => {
    const run = renderRun();
    await act(async () => {
      await run.handlers.onEdit(editAppend(String(USER_WITH_IMAGE), "Explain again"));
    });
    const branchStore = run.stores.get(String(BRANCHED_CHAT));
    if (!branchStore) throw new Error("the branched chat store was not created");

    await act(async () => {
      receiveOmp(branchStore, { type: "agent_start" }, 1);
      branchStore.ingest({ kind: "process", status: "exited" } as ChatSessionEvent, 2);
    });
    expect(branchStore.getSnapshot().prompt.admitted).toBe(true);
    expect(run.runs.status.getSnapshot()).toMatchObject({
      phase: "sent",
      threadId: BRANCHED_CHAT,
      settled: true,
    });
  });

  test("a run that settled before its status read sent settles when the status arrives", async () => {
    const run = renderRun();
    await act(async () => {
      await run.handlers.onEdit(editAppend(String(USER_WITH_IMAGE), "Explain again"));
    });
    const branchStore = run.stores.get(String(BRANCHED_CHAT));
    if (!branchStore) throw new Error("the branched chat store was not created");
    const sentState = run.runs.status.getSnapshot();
    if (sentState.phase !== "sent") throw new Error("the edit was not sent");

    await act(async () => {
      run.runs.status.set({ ...sentState, phase: "sending" });
      branchStore.ingest(promptPending("req-early"), 1);
      branchStore.ingest(SESSION_SETTLED, 2);
    });
    expect(run.runs.status.getSnapshot().phase).toBe("sending");

    await act(async () => run.runs.status.set(sentState));
    expect(run.runs.status.getSnapshot()).toMatchObject({
      phase: "sent",
      threadId: BRANCHED_CHAT,
      settled: true,
    });
  });
});
