import { type CapabilityMap, SubagentId, ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { P1CapabilityKeys } from "@/modules/P1/contract";
import type { AgentRosterStoreSnapshot, RosterAgent } from "@/modules/P1/roster";
import type { WorkersPanelSnapshot } from "./controller";
import { buildWorkersModel } from "./model";
import { WorkersPanelView } from "./view";

afterEach(cleanup);

const threadId = ThreadId.parse("thread-view");
const NOW = 3_000_000;

function agent(id: string, agentName: string, status: RosterAgent["status"]): RosterAgent {
  return {
    id: SubagentId.parse(id),
    index: 0,
    agent: agentName,
    agentSource: "bundled",
    status,
    lastUpdate: NOW,
    description: `Worker ${id}`,
    threadId,
    key: `${id}:1`,
    incarnation: 1,
    terminalAt: status === "running" ? null : NOW - 1,
    lifecycleSeq: 1,
    progressSeq: null,
    metrics: { durationMs: 65_000, receivedAt: NOW, raw: {} },
  };
}

function rosterOf(agents: readonly RosterAgent[]): AgentRosterStoreSnapshot {
  const active = agents.filter((item) => item.status === "running").map((item) => item.key);
  return {
    threadId,
    revision: 1,
    lastSeq: 1,
    agents: Object.fromEntries(agents.map((item) => [item.key, item])),
    order: agents.map((item) => item.key),
    active,
    recent: agents.filter((item) => item.status !== "running").map((item) => item.key),
  };
}

function snapshotOf(
  agents: readonly RosterAgent[],
  capabilities: CapabilityMap,
  patch: Partial<WorkersPanelSnapshot> = {},
): WorkersPanelSnapshot {
  return {
    model: buildWorkersModel({ snapshot: rosterOf(agents), now: NOW, capabilities }),
    loading: false,
    error: null,
    ...patch,
  };
}

function renderView(
  snapshot: WorkersPanelSnapshot,
  handlers: Partial<{
    onRetry: () => void;
    onStop: (id: string) => void;
    onOpenTranscript: (id: string) => void;
  }> = {},
) {
  const onOpenChange = vi.fn();
  const onRetry = handlers.onRetry ?? vi.fn();
  const onStop = handlers.onStop ?? vi.fn();
  render(
    <WorkersPanelView
      open
      position="right"
      snapshot={snapshot}
      onOpenChange={onOpenChange}
      onOpenTranscript={handlers.onOpenTranscript}
      onRetry={onRetry}
      onStop={onStop}
    />,
  );
  return { onRetry, onStop };
}

describe("WorkersPanelView", () => {
  test("shows the side-task, persistent worker and subagent sections, and no start control", () => {
    renderView(snapshotOf([], {}));
    expect(screen.getByText("Side-task workers")).toBeTruthy();
    expect(screen.getByText("Persistent workers")).toBeTruthy();
    expect(screen.getByText("Subagents")).toBeTruthy();
    expect(screen.getByText("Side-task workers are not reported here")).toBeTruthy();
    expect(screen.getByText("No subagents yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Start / })).toBeNull();
    expect(
      screen.getByText(
        "Subagents in this chat. Side-task and persistent workers are not reported to this app.",
      ),
    ).toBeTruthy();
  });

  test("offers Stop only for a running worker once omp can cancel, and calls onStop with the worker id", () => {
    const worker = agent("tan-1", "tan", "running");
    const { onStop } = renderView(snapshotOf([worker], {}));
    expect(screen.getByText("Worker tan-1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop Worker tan-1" })).toBeNull();
    cleanup();

    const onStopEnabled = vi.fn();
    renderView(
      snapshotOf([worker], { [P1CapabilityKeys.cancel]: { state: "available", via: "rpc" } }),
      {
        onStop: onStopEnabled,
      },
    );
    const enabled = screen.getByRole("button", { name: "Stop Worker tan-1" });
    expect(enabled.hasAttribute("disabled")).toBe(false);
    fireEvent.click(enabled);
    expect(onStopEnabled).toHaveBeenCalledWith("tan-1");
    expect(onStop).not.toHaveBeenCalled();
  });

  test("shows an ended worker without a Stop button, and its status in plain words", () => {
    renderView(snapshotOf([agent("done-1", "task", "completed")], {}));
    expect(screen.queryByRole("button", { name: /^Stop / })).toBeNull();
    expect(screen.getByText(/Finished · 1 minute 5 seconds/)).toBeTruthy();
  });

  test("shows the error with a retry that calls onRetry, and a loading notice while the roster is read", () => {
    const { onRetry } = renderView(
      snapshotOf([], {}, { error: "The workers could not be read. Try again." }),
    );
    expect(screen.getByRole("alert").textContent).toContain("The workers could not be read.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    cleanup();

    renderView(snapshotOf([], {}, { loading: true }));
    expect(screen.getByText("Loading")).toBeTruthy();
  });
});

describe("WorkersPanelView reports only what omp sends", () => {
  test("says omp does not report side-task or persistent workers here, and lists a side-task-named subagent under Subagents", () => {
    renderView(snapshotOf([agent("side-task-1", "task", "running")], {}));
    expect(screen.getByText("Side-task workers are not reported here")).toBeTruthy();
    expect(screen.getByText("Persistent workers are not reported here")).toBeTruthy();
    expect(screen.getByText("Subagents")).toBeTruthy();
    expect(screen.getByText("Worker side-task-1")).toBeTruthy();
  });

  test("shows no Stop for a queued worker, and reads a stop in flight as Stopping with its button disabled", () => {
    const queued = agent("queued-1", "task", "pending");
    const running = agent("tan-1", "tan", "running");
    renderView({
      model: buildWorkersModel({
        snapshot: rosterOf([queued, running]),
        now: NOW,
        capabilities: { [P1CapabilityKeys.cancel]: { state: "available", via: "rpc" } },
        stopping: new Set(["tan-1"]),
      }),
      loading: false,
      error: null,
    });
    expect(screen.queryByRole("button", { name: "Stop Worker queued-1" })).toBeNull();
    const inFlight = screen.getByRole("button", { name: "Stopping Worker tan-1" });
    expect(inFlight.hasAttribute("disabled")).toBe(true);
    expect(inFlight.textContent).toBe("Stopping...");
  });

  test("shows the model omp reports for a worker", () => {
    const worker = {
      ...agent("w-2", "task", "running"),
      metrics: {
        durationMs: 65_000,
        receivedAt: NOW,
        raw: { resolvedModel: "fake/fake-model:high" },
      },
    };
    renderView(snapshotOf([worker], {}));
    expect(screen.getByText(/fake\/fake-model:high/)).toBeTruthy();
  });
});
