import type { BackgroundJobStop, RpcSessionEvent } from "@omp-app/contracts";
import { ThreadId } from "@omp-app/contracts";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "@/modules/R0/store";
import { JobRows } from "@/modules/T5/coordination";
import { useJobStops } from "@/modules/T5/job-stops";
import type { JobSnapshot } from "@/modules/T5/models";
import { ToolRunActiveContext } from "@/modules/U1/tool-slots";
import { ToolRunScope } from "./tool-run-scope";

afterEach(() => cleanup());

function Probe() {
  const runActive = useContext(ToolRunActiveContext);
  return <p data-testid="run-active">{String(runActive)}</p>;
}

function addLaunch(
  store: OmpRuntimeStore,
  messageId: string,
  toolCallId: string,
  jobId: string,
  timestamp: number,
  seq: number,
  parentId: string | null,
) {
  const message = {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [],
    isError: false,
    timestamp,
    details: { async: { state: "running", jobId, type: "bash" } },
  };
  store.ingest(
    {
      kind: "omp",
      event: { type: "message_start", messageId, message },
    } as unknown as RpcSessionEvent,
    seq,
  );
  store.ingest(
    {
      kind: "omp",
      event: { type: "message_end", messageId, message },
    } as unknown as RpcSessionEvent,
    seq + 1,
  );
  return {
    type: "message",
    id: `entry-${toolCallId}`,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message,
  };
}

function TasksProbe() {
  const stops = useJobStops();
  const jobs: readonly JobSnapshot[] = [
    { id: "bg_1", type: "bash", status: "running", label: "long job", durationMs: 1000 },
    { id: "bg_2", type: "bash", status: "running", label: "stopped job", durationMs: 1000 },
  ];
  return <JobRows jobs={jobs} stops={stops} />;
}

describe("ToolRunScope", () => {
  test("hands kept stops and latest launches to Tasks rows", async () => {
    const store = new OmpRuntimeStore({ threadId: ThreadId.parse("thread-kept-stops") });
    const entries = [
      addLaunch(store, "old-bg-1", "call-old", "bg_1", 1_000, 1, null),
      addLaunch(store, "new-bg-1", "call-new", "bg_1", 2_000, 3, "entry-call-old"),
      addLaunch(store, "bg-2", "call-bg-2", "bg_2", 1_000, 5, "entry-call-new"),
    ];
    store.pairEndedMessages(entries);
    const stops: readonly BackgroundJobStop[] = [
      { jobId: "bg_1", status: "stopped", at: 1_500 },
      { jobId: "bg_2", status: "stopped", at: 1_500 },
    ];
    render(
      <ToolRunScope
        loadBackgroundJobStops={async () => stops}
        runBackgroundJobCommand={async () => []}
        store={store}
      >
        <TasksProbe />
      </ToolRunScope>,
    );

    await waitFor(() => expect(screen.getByText("Cancelled")).toBeTruthy());
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop background job 1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop background job 2" })).toBeNull();
  });
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
