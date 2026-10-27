import type { CapabilityMap, ChatSessionRequest, ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { endNoticeOnPrompt } from "@/modules/P3/runs";
import { createP3RunStatus, type P3RunState } from "@/modules/P3/runs/status";
import { createQueueController } from "@/modules/R0/actions";
import { OmpRuntimeStore, type OmpRuntimeTransport } from "@/modules/R0/store";

const threadId = "queue-notice-chat" as ThreadId;
const capabilities: CapabilityMap = {
  "omp.cmd.steer": { state: "available", via: "rpc" },
  "omp.cmd.follow_up": { state: "available", via: "rpc" },
  "omp.cmd.remove_queued_message": { state: "available", via: "rpc" },
  "omp.cmd.promote_queued_message": { state: "available", via: "rpc" },
  "omp.cmd.set_steering_mode": { state: "available", via: "rpc" },
  "omp.cmd.set_follow_up_mode": { state: "available", via: "rpc" },
  "omp.cmd.set_interrupt_mode": { state: "available", via: "rpc" },
};

/** A queue whose requests go through the same wrapper the app uses, with a finished notice shown. */
function queueWithNotice(send: ChatSessionRequest, phase: "sent" | "sending" = "sent") {
  const status = createP3RunStatus();
  status.set({ phase, chatThreadId: threadId, sourceThreadId: threadId } as unknown as P3RunState);
  const store = new OmpRuntimeStore({ threadId, transport: {} as OmpRuntimeTransport });
  const queue = createQueueController({
    store,
    send: endNoticeOnPrompt(send, status),
    capabilities,
  });
  return { queue, status };
}

describe("a queued message ends the notice once omp accepts it", () => {
  test("a queued follow-up that omp accepts ends a finished notice", async () => {
    const send = vi.fn(async () => ({}));
    const { queue, status } = queueWithNotice(send as unknown as ChatSessionRequest);

    await queue.submit({ text: "follow later", delivery: "followUp" });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ method: "follow_up", params: { text: "follow later" } }),
      expect.anything(),
    );
    expect(status.getSnapshot()).toEqual({ phase: "idle" });
  });

  test("a queued steer that omp accepts ends a finished notice", async () => {
    const send = vi.fn(async () => ({}));
    const { queue, status } = queueWithNotice(send as unknown as ChatSessionRequest);

    await queue.submit({ text: "steer now", delivery: "steer" });
    expect(status.getSnapshot()).toEqual({ phase: "idle" });
  });

  test("a queued message that omp refuses leaves the notice in place", async () => {
    const refused = vi.fn(async () => {
      throw new AppFailure({ code: "omp_error", message: "omp is busy", retryable: true });
    });
    const { queue, status } = queueWithNotice(refused as unknown as ChatSessionRequest);

    await expect(queue.submit({ text: "keep me", delivery: "followUp" })).rejects.toMatchObject({
      appError: { code: "omp_error" },
    });
    expect(status.getSnapshot().phase).toBe("sent");
  });

  test("a queued message does not end a run that is still sending", async () => {
    const send = vi.fn(async () => ({}));
    const { queue, status } = queueWithNotice(send as unknown as ChatSessionRequest, "sending");

    await queue.submit({ text: "wait for the run", delivery: "followUp" });
    expect(status.getSnapshot().phase).toBe("sending");
  });
});
