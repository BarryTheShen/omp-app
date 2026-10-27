import type { ChatSessionRequest } from "@omp-app/contracts";
import { ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { endNoticeOnPrompt } from "./prompt-ends-notice";

const threadId = ThreadIdSchema.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");

describe("a message the person sends ends a finished notice", () => {
  test("an accepted prompt ends the notice, and still reaches omp with its answer", async () => {
    const request = vi.fn(async () => ({ resultFollows: true }));
    const dismiss = vi.fn();
    const wrapped = endNoticeOnPrompt(request as unknown as ChatSessionRequest, { dismiss });
    const args = { threadId, method: "prompt", params: { text: "hello" } };

    await expect(wrapped(args as never, undefined)).resolves.toEqual({ resultFollows: true });
    expect(request).toHaveBeenCalledWith(args, undefined);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  test("a prompt omp refuses ends nothing, and its refusal reaches the caller", async () => {
    const dismiss = vi.fn();
    const refused = vi.fn(async () => {
      throw new Error("omp is busy");
    });
    const wrapped = endNoticeOnPrompt(refused as unknown as ChatSessionRequest, { dismiss });

    await expect(
      wrapped({ threadId, method: "prompt", params: { text: "hello" } } as never, undefined),
    ).rejects.toThrow("omp is busy");
    expect(dismiss).not.toHaveBeenCalled();
  });

  test("any other request passes through and leaves the notice alone", async () => {
    const dismiss = vi.fn();
    const request = vi.fn(async () => ({}));
    const wrapped = endNoticeOnPrompt(request as unknown as ChatSessionRequest, { dismiss });

    await wrapped({ threadId, method: "get_state", params: {} } as never, undefined);
    expect(request).toHaveBeenCalledTimes(1);
    expect(dismiss).not.toHaveBeenCalled();
  });

  test.each([
    { method: "steer", params: { text: "later" }, what: "A steer" },
    { method: "follow_up", params: { text: "later" }, what: "A follow-up" },
    {
      method: "promote_queued_message",
      params: { message: "later" },
      what: "A promoted queued message",
    },
  ])("$what that omp accepts ends the notice", async ({ method, params }) => {
    const request = vi.fn(async () => ({}));
    const dismiss = vi.fn();
    const wrapped = endNoticeOnPrompt(request as unknown as ChatSessionRequest, { dismiss });

    await wrapped({ threadId, method, params } as never, undefined);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  test("removing a queued message ends nothing", async () => {
    const dismiss = vi.fn();
    const request = vi.fn(async () => ({ removed: true, text: "later" }));
    const wrapped = endNoticeOnPrompt(request as unknown as ChatSessionRequest, { dismiss });

    const params = { message: "later", queue: "followUp" };
    await wrapped({ threadId, method: "remove_queued_message", params } as never, undefined);
    expect(dismiss).not.toHaveBeenCalled();
  });
});
