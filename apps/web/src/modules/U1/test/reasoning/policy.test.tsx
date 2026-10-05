import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  MemoryThinkingVisibilityStore,
  shouldRenderReasoning,
  TranscriptDisplayPolicyProvider,
  useTranscriptDisplayPolicy,
} from "../../policy";

function PolicyView() {
  const policy = useTranscriptDisplayPolicy();
  return (
    <>
      <output data-testid="thinking-state">{policy.thinking}</output>
      <button type="button" onClick={policy.toggleThinking}>
        Toggle
      </button>
    </>
  );
}

afterEach(cleanup);

describe("TranscriptDisplayPolicy", () => {
  test("remembers thinking visibility per thread", () => {
    const storage = new MemoryThinkingVisibilityStore();
    const view = render(
      <TranscriptDisplayPolicyProvider storage={storage} threadId="thread-a">
        <PolicyView />
      </TranscriptDisplayPolicyProvider>,
    );

    expect(screen.getByTestId("thinking-state").textContent).toBe("visible");
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    expect(screen.getByTestId("thinking-state").textContent).toBe("hidden");

    view.unmount();
    render(
      <TranscriptDisplayPolicyProvider storage={storage} threadId="thread-a">
        <PolicyView />
      </TranscriptDisplayPolicyProvider>,
    );
    expect(screen.getByTestId("thinking-state").textContent).toBe("hidden");

    cleanup();
    render(
      <TranscriptDisplayPolicyProvider storage={storage} threadId="thread-b">
        <PolicyView />
      </TranscriptDisplayPolicyProvider>,
    );
    expect(screen.getByTestId("thinking-state").textContent).toBe("visible");
  });

  test("keeps only an active hidden pulse renderable", () => {
    const policy = {
      threadId: "thread-a",
      thinking: "hidden" as const,
      tools: "visible" as const,
      expandTools: false,
      setThinking: () => undefined,
      toggleThinking: () => undefined,
    };

    expect(shouldRenderReasoning({ active: true, policy })).toBe(true);
    expect(shouldRenderReasoning({ active: false, policy })).toBe(false);
    expect(
      shouldRenderReasoning({ active: false, policy: { ...policy, thinking: "visible" } }),
    ).toBe(true);
  });
});
