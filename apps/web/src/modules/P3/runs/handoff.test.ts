import { ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type { PromptIntent } from "@/modules/R0/runtime";
import { type P3PromptRuntime, P3ThreadHandoff } from "./handoff";

const intent: PromptIntent = { mode: "prompt", text: "edited", delivery: "new" };
const firstChat = ThreadIdSchema.parse("branch-one");
const secondChat = ThreadIdSchema.parse("branch-two");

function recordingRuntime(): { readonly runtime: P3PromptRuntime; readonly sent: PromptIntent[] } {
  const sent: PromptIntent[] = [];
  return {
    runtime: {
      submitPrompt: async (value) => {
        sent.push(value);
      },
    },
    sent,
  };
}

describe("P3ThreadHandoff", () => {
  test("waits for the opened chat to mount, then sends through its runtime", async () => {
    const onAdmitted = vi.fn();
    const handoff = new P3ThreadHandoff({ onAdmitted });
    const { runtime, sent } = recordingRuntime();
    handoff.beginRun();
    handoff.expect(firstChat);

    const admitted = handoff.submit(intent);
    expect(sent).toEqual([]);
    const detach = handoff.attach(firstChat, runtime);

    await expect(admitted).resolves.toBe(firstChat);
    expect(sent).toEqual([intent]);
    expect(onAdmitted).toHaveBeenCalledTimes(1);
    detach();
  });

  test("sends straight away when the opened chat is already mounted", async () => {
    const handoff = new P3ThreadHandoff();
    const { runtime, sent } = recordingRuntime();
    handoff.attach(firstChat, runtime);
    handoff.expect(firstChat);

    await expect(handoff.submit(intent)).resolves.toBe(firstChat);
    expect(sent).toEqual([intent]);
  });

  test("refuses to send when no chat was opened for the run", async () => {
    const handoff = new P3ThreadHandoff();
    await expect(handoff.submit(intent)).rejects.toMatchObject({
      appError: { code: "conflict", retryable: false },
    });
  });

  test("drops a waiting send when the run opens another chat", async () => {
    const handoff = new P3ThreadHandoff();
    handoff.expect(firstChat);
    const waiting = handoff.submit(intent);

    handoff.expect(secondChat);

    await expect(waiting).rejects.toMatchObject({ appError: { code: "cancelled" } });
    expect(handoff.target).toBe(secondChat);
  });

  test("a new run drops the send of an earlier run and clears the opened chat", async () => {
    const handoff = new P3ThreadHandoff();
    handoff.expect(firstChat);
    const waiting = handoff.submit(intent);

    handoff.beginRun();

    await expect(waiting).rejects.toMatchObject({ appError: { code: "cancelled" } });
    expect(handoff.target).toBeNull();
  });

  test("gives up with a retryable timeout when the chat never mounts", async () => {
    const handoff = new P3ThreadHandoff({ mountTimeoutMs: 5 });
    handoff.expect(firstChat);

    await expect(handoff.submit(intent)).rejects.toMatchObject({
      appError: { code: "timeout", retryable: true },
    });
  });

  test("stops sending through a runtime once its chat unmounts", async () => {
    const handoff = new P3ThreadHandoff({ mountTimeoutMs: 5 });
    const { runtime, sent } = recordingRuntime();
    const detach = handoff.attach(firstChat, runtime);
    detach();
    handoff.expect(firstChat);

    await expect(handoff.submit(intent)).rejects.toMatchObject({
      appError: { code: "timeout" },
    });
    expect(sent).toEqual([]);
  });
});
