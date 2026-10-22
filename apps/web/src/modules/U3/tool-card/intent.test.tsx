import type { RpcSessionEvent, ThreadId, ToolCallId } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { OmpRuntimeStore, type ToolCallState } from "@/modules/R0/store/store";
import { BashCard } from "./bash";
import { ToolCard } from "./card";
import type { ToolRendererProps } from "./contract";
import { normalizeToolCall } from "./normalize";

afterEach(() => cleanup());

const threadId = "thread-intent" as ThreadId;
const callId = "call-intent" as ToolCallId;
const INTENT = "Reading the config for the port";
const COMMAND = "sleep 6; echo intent-done";

/** omp's start event for one bash call; the model's `i` argument arrives on it as `intent`. */
function startEvent(intent?: string): Record<string, unknown> {
  return {
    type: "tool_execution_start",
    toolCallId: callId,
    toolName: "bash",
    args: { command: COMMAND },
    ...(intent === undefined ? {} : { intent }),
  };
}

const endEvent: Record<string, unknown> = {
  type: "tool_execution_end",
  toolCallId: callId,
  toolName: "bash",
  isError: false,
};

/** The R0 state of the call after omp's events for it, in order, as the store keeps it. */
function toolStateAfter(...events: readonly Record<string, unknown>[]): ToolCallState {
  const store = new OmpRuntimeStore({ threadId });
  events.forEach((event, index) => {
    const wrapped: unknown = { kind: "omp", event };
    store.ingest(wrapped as RpcSessionEvent, index + 1, false);
  });
  const state = store.getSnapshot().tools[callId];
  if (state === undefined) throw new Error("The store did not record the call.");
  return state;
}

function bashProps(
  toolState: ToolCallState | undefined,
  status: ToolRendererProps["status"],
  args: { readonly command: string; readonly i?: string } = { command: COMMAND },
): ToolRendererProps {
  // A fixture: the renderer reads these fields, and the parts of a full assistant-ui message that it never reads are left out.
  const fixture = {
    toolCallId: callId,
    toolName: "bash",
    args,
    argsText: JSON.stringify(args),
    status,
    toolState,
  };
  return fixture as unknown as ToolRendererProps;
}

describe("a running tool call shows the intent omp sent", () => {
  test("a running bash call shows its intent on its summary line, in place of the command", () => {
    const state = toolStateAfter(startEvent(INTENT));
    render(<BashCard rendererProps={bashProps(state, { type: "running" })} />);

    expect(screen.getByText(INTENT)).toBeTruthy();
    expect(screen.queryByText(COMMAND)).toBeNull();
  });

  test("a running bash call without an intent keeps its command on the summary line", () => {
    const state = toolStateAfter(startEvent());
    render(<BashCard rendererProps={bashProps(state, { type: "running" })} />);

    expect(screen.getByText(COMMAND)).toBeTruthy();
  });

  test("a finished bash call shows its command again, and no intent", () => {
    const state = toolStateAfter(startEvent(INTENT), endEvent);
    render(<BashCard rendererProps={bashProps(state, { type: "complete" })} />);

    expect(screen.getByText(COMMAND)).toBeTruthy();
    expect(screen.queryByText(INTENT)).toBeNull();
  });

  test("the streamed intent shows before omp starts the call", () => {
    const streamed = { command: COMMAND, i: INTENT };
    render(
      <BashCard
        rendererProps={bashProps(
          undefined,
          { type: "requires-action", reason: "interrupt" },
          streamed,
        )}
      />,
    );

    expect(screen.getByText(INTENT)).toBeTruthy();
  });

  test("the normalized state keeps the intent only while the call is in flight, without trailing periods", () => {
    const running = normalizeToolCall({
      toolCallId: callId,
      toolName: "bash",
      args: { command: COMMAND },
      status: { type: "running" },
      toolState: toolStateAfter(startEvent("Reading the config for the port...")),
    });
    expect(running.intent).toBe(INTENT);

    const finished = normalizeToolCall({
      toolCallId: callId,
      toolName: "bash",
      args: { command: COMMAND },
      status: { type: "complete" },
      toolState: toolStateAfter(startEvent(INTENT), endEvent),
    });
    expect(finished.intent).toBeUndefined();
  });

  test("a running card with no family summary shows its intent in place of Working…", () => {
    const state = normalizeToolCall({
      toolCallId: callId,
      toolName: "bash",
      args: { command: COMMAND },
      status: { type: "running" },
      toolState: toolStateAfter(startEvent(INTENT)),
    });
    render(<ToolCard state={state} />);

    expect(screen.getByText(INTENT)).toBeTruthy();
    expect(screen.queryByText("Working…")).toBeNull();
  });

  test("a running card without an intent still says Working…", () => {
    const state = normalizeToolCall({
      toolCallId: callId,
      toolName: "bash",
      args: { command: COMMAND },
      status: { type: "running" },
      toolState: toolStateAfter(startEvent()),
    });
    render(<ToolCard state={state} />);

    expect(screen.getByText("Working…")).toBeTruthy();
  });
});
