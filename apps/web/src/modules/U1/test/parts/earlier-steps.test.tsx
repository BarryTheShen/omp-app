import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { OmpMessage, RpcSessionEvent, RpcSessionSend, ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useOmpRuntime } from "../../../R0/runtime";
import { OmpRuntimeStore } from "../../../R0/store";
import {
  EARLIER_STEPS_PAGE,
  earlierStepsEnd,
  KEEP_LAST_STEPS,
  MessageParts,
  MIN_EARLIER_STEPS,
} from "../../parts";
import { ThreadShell } from "../../thread";

const originalScrollTo = HTMLElement.prototype.scrollTo;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: originalScrollTo,
  });
});

const threadId = "u1-earlier-steps-test" as ThreadId;
const capabilities = { "omp.cmd.prompt": { state: "available" as const, via: "rpc" as const } };
const send: RpcSessionSend = async () => undefined as never;

function stepLabel(index: number): string {
  return `step-${String(index).padStart(4, "0")}`;
}

/** One assistant turn of `count` steps; every step is a text part with its own label. */
function turnOf(count: number): OmpMessage {
  return {
    role: "assistant",
    content: Array.from({ length: count }, (_, index) => ({
      type: "text",
      text: stepLabel(index),
    })),
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1_759_600_000_000,
  } as unknown as OmpMessage;
}

function renderTurn(count: number): void {
  const store = new OmpRuntimeStore({ threadId });
  store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 1);
  store.ingest(
    {
      kind: "omp",
      event: { type: "message_start", messageId: "assistant-1", message: turnOf(count) },
    },
    2,
  );
  function Thread() {
    const { runtime } = useOmpRuntime({ store, send, capabilities });
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadShell
          slots={{ renderMessage: (message) => <MessageParts message={message} /> }}
          store={store}
        />
      </AssistantRuntimeProvider>
    );
  }
  render(<Thread />);
}

/** How many of the turn's steps are on the page right now. */
function mountedSteps(count: number): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (screen.queryByText(stepLabel(index)) !== null) indexes.push(index);
  }
  return indexes;
}

describe("a very long turn folds its earlier steps", () => {
  test("folds from the first step that leaves the latest twenty, and only when that hides twenty or more", () => {
    expect(KEEP_LAST_STEPS).toBe(20);
    expect(MIN_EARLIER_STEPS).toBe(20);
    expect(earlierStepsEnd(0)).toBe(0);
    expect(earlierStepsEnd(39)).toBe(0);
    expect(earlierStepsEnd(40)).toBe(20);
    expect(earlierStepsEnd(1_472)).toBe(1_452);
  });

  test("a turn of 60 steps shows its latest 20 and one closed button for the 40 before them", () => {
    renderTurn(60);
    const toggle = screen.getByRole("button", { name: "40 earlier steps" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(mountedSteps(60)).toEqual(Array.from({ length: 20 }, (_, index) => 40 + index));
  });

  test("a turn of 39 steps is shown whole, with no fold", () => {
    renderTurn(39);
    expect(screen.queryByRole("button", { name: /earlier steps/ })).toBeNull();
    expect(mountedSteps(39)).toHaveLength(39);
  });

  test("opening the fold mounts the first 50 folded steps, and the buttons add the rest in pages", () => {
    renderTurn(130);
    // 130 steps: the first 110 fold away.
    const toggle = screen.getByRole("button", { name: "110 earlier steps" });
    expect(mountedSteps(130)).toEqual(Array.from({ length: 20 }, (_, index) => 110 + index));

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(mountedSteps(130)).toEqual([
      ...Array.from({ length: EARLIER_STEPS_PAGE }, (_, index) => index),
      ...Array.from({ length: 20 }, (_, index) => 110 + index),
    ]);

    fireEvent.click(screen.getByRole("button", { name: `Show ${EARLIER_STEPS_PAGE} more steps` }));
    expect(mountedSteps(130)).toHaveLength(100 + 20);
    // Ten are left, so the paging button is gone and one button shows them.
    expect(screen.queryByRole("button", { name: /Show 50 more steps/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the last 10" }));
    expect(mountedSteps(130)).toHaveLength(130);
    expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();

    // Closing it takes them off the page again.
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(mountedSteps(130)).toEqual(Array.from({ length: 20 }, (_, index) => 110 + index));
  });

  test("'Show all' mounts every folded step at once", () => {
    renderTurn(130);
    fireEvent.click(screen.getByRole("button", { name: "110 earlier steps" }));
    fireEvent.click(screen.getByRole("button", { name: "Show all 60 remaining" }));
    expect(mountedSteps(130)).toHaveLength(130);
  });
});
