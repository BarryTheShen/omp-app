import type { RpcSessionSend } from "@omp-app/contracts";
import { ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { endNoticeOnPrompt } from "./prompt-ends-notice";

const threadId = ThreadIdSchema.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");

describe("a message the person sends ends a finished notice", () => {
  test("an accepted prompt ends the notice, and still reaches omp with its answer", async () => {
    const send = vi.fn(async () => ({ success: true }));
    const dismiss = vi.fn();
    const wrapped = endNoticeOnPrompt(send as unknown as RpcSessionSend, { dismiss });
    const args = { threadId, command: { type: "prompt", message: "hello" } };

    await expect(wrapped(args as never, undefined)).resolves.toEqual({ success: true });
    expect(send).toHaveBeenCalledWith(args, undefined);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  test("a prompt omp refuses ends nothing, and its refusal reaches the caller", async () => {
    const dismiss = vi.fn();
    const refused = vi.fn(async () => {
      throw new Error("omp is busy");
    });
    const wrapped = endNoticeOnPrompt(refused as unknown as RpcSessionSend, { dismiss });

    await expect(
      wrapped({ threadId, command: { type: "prompt", message: "hello" } } as never, undefined),
    ).rejects.toThrow("omp is busy");
    expect(dismiss).not.toHaveBeenCalled();
  });

  test("any other command passes through and leaves the notice alone", async () => {
    const dismiss = vi.fn();
    const send = vi.fn(async () => ({}));
    const wrapped = endNoticeOnPrompt(send as unknown as RpcSessionSend, { dismiss });

    await wrapped({ threadId, command: { type: "get_state" } } as never, undefined);
    expect(send).toHaveBeenCalledTimes(1);
    expect(dismiss).not.toHaveBeenCalled();
  });

  test.each([
    { type: "steer", what: "A steer" },
    { type: "follow_up", what: "A follow-up" },
    { type: "promote_queued_message", what: "A promoted queued message" },
  ])("$what that omp accepts ends the notice", async ({ type }) => {
    const send = vi.fn(async () => ({ success: true }));
    const dismiss = vi.fn();
    const wrapped = endNoticeOnPrompt(send as unknown as RpcSessionSend, { dismiss });

    await wrapped({ threadId, command: { type, message: "later" } } as never, undefined);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  test("removing a queued message ends nothing", async () => {
    const dismiss = vi.fn();
    const send = vi.fn(async () => ({ changed: true }));
    const wrapped = endNoticeOnPrompt(send as unknown as RpcSessionSend, { dismiss });

    const command = { type: "remove_queued_message", message: "later", queue: "followUp" };
    await wrapped({ threadId, command } as never, undefined);
    expect(dismiss).not.toHaveBeenCalled();
  });
});
