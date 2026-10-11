import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { type PropsWithChildren, useContext, useMemo } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ReadOnlyNestedTranscript, TurnCancelContext, TurnCancelScope } from "../../thread";

afterEach(() => cleanup());

/** What the probe found in the context, so a test can tell the stop it was given from a stop it was not. */
const seen: { value: unknown } = { value: undefined };

function Probe() {
  seen.value = useContext(TurnCancelContext);
  return <p data-testid="probe">{seen.value === undefined ? "none" : "given"}</p>;
}

/** A chat runtime that can cancel, as the composer sees it, running or settled. */
function ChatRuntime({ running, children }: PropsWithChildren<{ readonly running: boolean }>) {
  const messages = useMemo<readonly ThreadMessage[]>(() => [], []);
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: running,
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

describe("TurnCancelScope", () => {
  test("gives the chat's stop only while the turn runs, on the composer's condition", () => {
    const cancel = vi.fn(async () => undefined);
    const scoped = (running: boolean) => (
      <ChatRuntime running={running}>
        <TurnCancelScope cancel={cancel}>
          <Probe />
        </TurnCancelScope>
      </ChatRuntime>
    );
    const { rerender } = render(scoped(true));
    expect(screen.getByTestId("probe").textContent).toBe("given");
    expect(seen.value).toBe(cancel);

    rerender(scoped(false));
    expect(screen.getByTestId("probe").textContent).toBe("none");
  });
});

describe("ReadOnlyNestedTranscript", () => {
  test("withholds the chat's stop from its cards, even while the chat's turn runs", () => {
    const cancel = vi.fn(async () => undefined);
    render(
      <ChatRuntime running>
        <TurnCancelScope cancel={cancel}>
          <ReadOnlyNestedTranscript messages={[]}>
            <Probe />
          </ReadOnlyNestedTranscript>
        </TurnCancelScope>
      </ChatRuntime>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("none");
  });
});
