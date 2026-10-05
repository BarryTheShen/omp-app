import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HiddenThinkingPulse, ReasoningDisclosure, reasoningGroupBy } from "../../reasoning";

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
});
