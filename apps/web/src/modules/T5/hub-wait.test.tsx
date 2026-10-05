import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { HubCard } from "./hub";
import { WaitCard } from "./wait";

afterEach(() => cleanup());

function rendererProps(toolName: string, result: unknown): ToolRendererProps {
  return {
    toolCallId: `${toolName}-call`,
    toolName,
    args: {},
    argsText: "{}",
    result,
  } as unknown as ToolRendererProps;
}

describe("T5.3 hub coordination card", () => {
  test("renders jobs, IRC sender/recipient bodies, receipts, and duration", () => {
    render(
      <HubCard
        rendererProps={rendererProps("hub", {
          op: "send",
          target: "agent-1",
          status: "delivered",
          durationMs: 1_250,
          jobs: [
            { id: "job-1", type: "task", status: "running", label: "Analyze", completion: 40 },
          ],
          messages: [{ id: "msg-1", from: "alice", to: "bob", text: "untrusted body" }],
          receipts: [{ id: "receipt-1", accepted: true, delivered: true, messageId: "msg-1" }],
        })}
      />,
    );
    expect(screen.getByText("Operation: send")).toBeTruthy();
    expect(screen.getByText("Target: agent-1")).toBeTruthy();
    expect(screen.getByText("alice → bob")).toBeTruthy();
    expect(screen.getByText("untrusted body")).toBeTruthy();
    expect(screen.getByText("Analyze")).toBeTruthy();
    expect(screen.getByText("1.3s")).toBeTruthy();
    expect(screen.getByText("msg-1")).toBeTruthy();
    expect(screen.getByText("Delivered")).toBeTruthy();
  });
});

describe("T5.3 wait coordination card", () => {
  test("renders counts, model/thinking labels, sealed state, and bounded previews", () => {
    render(
      <WaitCard
        rendererProps={rendererProps("wait", {
          op: "wait",
          sealed: true,
          durationMs: 2_000,
          summary: { estimate: "soon", total: 3 },
          jobs: [
            { id: "running", type: "task", status: "running", model: "model-a", thinking: "high" },
            { id: "done", type: "task", status: "completed", result: "finished" },
            { id: "failed", type: "task", status: "failed", result: "failed result" },
            { id: "cancelled", type: "task", status: "cancelled" },
          ],
        })}
      />,
    );
    expect(screen.getByText("Running 1")).toBeTruthy();
    expect(screen.getByText("Completed 1")).toBeTruthy();
    expect(screen.getByText("Failed 1")).toBeTruthy();
    expect(screen.getByText("Cancelled 1")).toBeTruthy();
    expect(screen.getByText("Sealed; still running")).toBeTruthy();
    expect(screen.getByText("model-a")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText("finished")).toBeTruthy();
  });
});
