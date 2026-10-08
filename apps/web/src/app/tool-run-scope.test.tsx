import { ThreadId } from "@omp-app/contracts";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "@/modules/R0/store";
import { ToolRunActiveContext } from "@/modules/U1/tool-slots";
import { ToolRunScope } from "./tool-run-scope";

afterEach(() => cleanup());

function Probe() {
  const runActive = useContext(ToolRunActiveContext);
  return <p data-testid="run-active">{String(runActive)}</p>;
}

describe("ToolRunScope", () => {
  test("gives the tool calls the chat's prompt flag, and follows it as the run starts and ends", () => {
    const store = new OmpRuntimeStore({ threadId: ThreadId.parse("thread-run") });
    render(
      <ToolRunScope store={store}>
        <Probe />
      </ToolRunScope>,
    );
    expect(screen.getByTestId("run-active").textContent).toBe("false");

    act(() => store.applySessionState({ isStreaming: true }));
    expect(screen.getByTestId("run-active").textContent).toBe("true");

    act(() => store.applySessionState({ isStreaming: false }));
    expect(screen.getByTestId("run-active").textContent).toBe("false");
  });
});
