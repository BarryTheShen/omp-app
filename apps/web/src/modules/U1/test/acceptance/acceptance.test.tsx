import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { validateRegistry } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useOmpRuntime } from "../../../R0/runtime";
import { TranscriptContentReader } from "../../copy";
import {
  createU1AcceptanceFixture,
  U1_ACCEPTANCE_CAPABILITIES,
  U1_ACCEPTANCE_F6_IDS,
  type U1AcceptanceFixture,
} from "../../fixtures";
import { MessageParts } from "../../parts";
import { U1MessageDescriptors } from "../../registry/messages";
import { U1ShortcutDescriptors } from "../../registry/shortcuts";
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

function AcceptanceThread({
  fixture,
  onRetry,
}: {
  readonly fixture: U1AcceptanceFixture;
  readonly onRetry?: () => void;
}) {
  const { runtime } = useOmpRuntime({
    store: fixture.store,
    send: fixture.send,
    capabilities: U1_ACCEPTANCE_CAPABILITIES,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadShell
        onRetry={onRetry}
        slots={{ renderMessage: (message) => <MessageParts message={message} /> }}
        store={fixture.store}
      />
    </AssistantRuntimeProvider>
  );
}

function assistantRow(): Element | null {
  return document.querySelector('[data-slot="u1-message-row"][data-role="assistant"]');
}

describe("U1 acceptance", () => {
  test("covers all U1 F6 rows once and passes C0 registry validation", () => {
    const descriptors = [...U1MessageDescriptors, ...U1ShortcutDescriptors];
    const covered = descriptors.flatMap((descriptor) => descriptor.covers);

    expect(covered).toHaveLength(U1_ACCEPTANCE_F6_IDS.length);
    expect(new Set(covered).size).toBe(U1_ACCEPTANCE_F6_IDS.length);
    expect([...covered].sort()).toEqual([...U1_ACCEPTANCE_F6_IDS].sort());
    expect(validateRegistry(descriptors)).toEqual([]);
  });

  test("renders a synthetic R0 stream with stable rows, accessible landmarks, and raw copy", async () => {
    const fixture = createU1AcceptanceFixture();
    render(<AcceptanceThread fixture={fixture} />);

    const viewport = screen.getByRole("region", { name: "Messages" });
    expect(viewport.getAttribute("aria-live")).toBe("off");
    expect(viewport.getAttribute("tabindex")).toBe("0");
    expect(screen.getByText("Summarize this fixture conversation.")).toBeTruthy();
    expect(screen.getByText("The fixture response")).toBeTruthy();

    const initialKey = assistantRow()?.getAttribute("data-message-id");
    expect(initialKey).toBeTruthy();
    fixture.updateAssistant();
    await screen.findByText("stable", { exact: true });
    expect(assistantRow()?.textContent).toContain("The fixture response is stable across deltas.");
    expect(
      document.querySelectorAll('[data-slot="u1-message-row"][data-role="assistant"]'),
    ).toHaveLength(1);
    expect(assistantRow()?.getAttribute("data-message-id")).toBe(initialKey);

    fixture.finishAssistant();
    await screen.findByText("Conversation settled");
    const copiedText = TranscriptContentReader.readMany(fixture.store.getSnapshot())
      .map((content) => content.markdown)
      .join(" ");
    expect(copiedText).toContain("The fixture response is **stable** across deltas.");
  });

  test("keeps runtime errors recoverable and forwards retry", () => {
    const fixture = createU1AcceptanceFixture();
    fixture.failRuntime();
    const retry = vi.fn();
    render(<AcceptanceThread fixture={fixture} onRetry={retry} />);

    expect(screen.getByRole("alert").textContent).toContain("The runtime was blocked");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
