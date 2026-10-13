import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  MemoryThinkingVisibilityStore,
  TranscriptDisplayPolicyProvider,
  useTranscriptDisplayPolicy,
} from "../../policy";
import {
  HiddenThinkingPulse,
  ReasoningDisclosure,
  ReasoningGroup,
  reasoningGroupBy,
} from "../../reasoning";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Sets the chat's thinking choice the way Alt+T does, once the chat has rendered. */
function ThinkingChoice({
  thinking,
  children,
}: {
  readonly thinking: "visible" | "hidden";
  readonly children: ReactNode;
}) {
  const { setThinking } = useTranscriptDisplayPolicy();
  useEffect(() => setThinking(thinking), [setThinking, thinking]);
  return <>{children}</>;
}

function renderGroup(thinking: "visible" | "hidden", status: "running" | "complete") {
  const group = { type: "group-reasoning", status: { type: status } } as unknown as Parameters<
    typeof ReasoningGroup
  >[0]["group"];
  return render(
    <TranscriptDisplayPolicyProvider
      storage={new MemoryThinkingVisibilityStore()}
      threadId="thread-1"
    >
      <ThinkingChoice thinking={thinking}>
        <ReasoningGroup group={group}>
          <p>reasoning text</p>
        </ReasoningGroup>
      </ThinkingChoice>
    </TranscriptDisplayPolicyProvider>,
  );
}

describe("reasoning disclosure", () => {
  test("shows one fixed-width pulse for active hidden thinking and no finished ghost", () => {
    const view = render(<HiddenThinkingPulse />);
    const pulse = screen.getByRole("status", { name: "Thinking" });
    expect(pulse.getAttribute("data-u1-thinking-pulse")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Thinking");

    view.rerender(
      <ReasoningDisclosure hidden streaming={false}>
        <p>hidden reasoning</p>
      </ReasoningDisclosure>,
    );
    expect(screen.queryByRole("status", { name: "Thinking" })).toBeNull();
  });

  test("stays expanded while streaming and auto-collapses when the answer starts", () => {
    const view = render(
      <ReasoningDisclosure durationSeconds={12} streaming>
        <p>reasoning text</p>
      </ReasoningDisclosure>,
    );
    const trigger = screen.getByRole("button", { name: "Thought for 12s" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("reasoning text")).toBeTruthy();

    view.rerender(
      <ReasoningDisclosure durationSeconds={12} streaming={false}>
        <p>reasoning text</p>
      </ReasoningDisclosure>,
    );
    expect(
      screen.getByRole("button", { name: "Thought for 12s" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });
  test("groups reasoning leaves separately from answer text", () => {
    const reasoning = reasoningGroupBy({
      type: "reasoning",
      text: "one thought",
      status: { type: "complete" },
    } as Parameters<typeof reasoningGroupBy>[0]);
    const text = reasoningGroupBy({
      type: "text",
      text: "answer",
      status: { type: "complete" },
    } as Parameters<typeof reasoningGroupBy>[0]);

    expect(reasoning).toEqual(["group-reasoning"]);
    expect(text).toEqual([]);
  });
  test("a hidden reasoning group that is still streaming shows the one pulse and draws no reasoning text", () => {
    renderGroup("hidden", "running");
    expect(screen.getByRole("status", { name: "Thinking" })).toBeTruthy();
    expect(screen.queryByText("reasoning text")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Thought/ })).toBeNull();
  });

  test("a hidden reasoning group that has finished draws nothing", () => {
    renderGroup("hidden", "complete");
    expect(screen.queryByRole("status", { name: "Thinking" })).toBeNull();
    expect(screen.queryByText("reasoning text")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Thought/ })).toBeNull();
  });

  test("a visible reasoning group that is streaming keeps its disclosure open with the live text", () => {
    renderGroup("visible", "running");
    expect(screen.getByRole("button", { name: /^Thought/ }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(screen.getByText("reasoning text")).toBeTruthy();
  });
});
