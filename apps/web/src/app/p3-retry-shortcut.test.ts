import type { ThreadId } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { createP3RunStatus, type P3FailedState, type P3RunState } from "@/modules/P3/runs/status";
import { P3_SHORTCUT_DESCRIPTORS } from "@/modules/P3/shortcuts/descriptors";
import { MemoryPreferenceStore, ShortcutRegistry } from "@/shortcuts/registry";
import { registerRetryShortcut } from "./p3-retry-shortcut";

const chat = "chat-retry" as ThreadId;
const otherChat = "chat-other" as ThreadId;

/** A run state shaped like P3's status; only the fields the rule reads matter here. */
function state(overrides: Record<string, unknown>): P3RunState {
  return {
    phase: "failed",
    retryable: true,
    chatThreadId: chat,
    sourceThreadId: chat,
    message: "The edit failed.",
    ...overrides,
  } as unknown as P3RunState;
}

function setup(current: P3RunState) {
  const registry = new ShortcutRegistry(P3_SHORTCUT_DESCRIPTORS, {
    preferenceStore: new MemoryPreferenceStore(),
  });
  const retry = vi.fn(async (_failure: P3FailedState) => undefined);
  const dispose = registerRetryShortcut({
    registry,
    threadId: chat,
    status: { getSnapshot: () => current },
    retry,
  });
  return { registry, retry, dispose };
}

function altR(): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "r", altKey: true, bubbles: true, cancelable: true });
}

describe("Alt+R retries the failed turn exactly when Try again is offered", () => {
  test("a retryable failure in this chat is retried, with that failure", () => {
    const failed = state({});
    const { registry, retry } = setup(failed);
    const event = altR();
    expect(registry.dispatch(event, "global").handled).toBe(true);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith(failed);
  });

  test("a failure that cannot be retried is left alone", () => {
    const { registry, retry } = setup(state({ retryable: false }));
    registry.dispatch(altR(), "global");
    expect(retry).not.toHaveBeenCalled();
  });

  test("a failure that belongs to another chat is left alone", () => {
    const { registry, retry } = setup(state({ chatThreadId: otherChat }));
    registry.dispatch(altR(), "global");
    expect(retry).not.toHaveBeenCalled();
  });

  test("with no failure in progress, Alt+R does nothing", () => {
    const { registry, retry } = setup(state({ phase: "sent" }));
    registry.dispatch(altR(), "global");
    expect(retry).not.toHaveBeenCalled();
  });

  test("a failure the person dismissed is no longer retried", () => {
    const status = createP3RunStatus();
    status.set(state({}));
    const registry = new ShortcutRegistry(P3_SHORTCUT_DESCRIPTORS, {
      preferenceStore: new MemoryPreferenceStore(),
    });
    const retry = vi.fn(async (_failure: P3FailedState) => undefined);
    registerRetryShortcut({ registry, threadId: chat, status, retry });

    status.dismiss();
    registry.dispatch(altR(), "global");
    expect(retry).not.toHaveBeenCalled();
  });

  test("disposing removes the action", () => {
    const { registry, retry, dispose } = setup(state({}));
    dispose();
    expect(registry.dispatch(altR(), "global").handled).toBe(false);
    expect(retry).not.toHaveBeenCalled();
  });
});
