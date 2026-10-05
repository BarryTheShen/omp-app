import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { CompactionPort, ContextUsagePort } from "../contract";
import { CompactionControls } from "./compaction-controls";
import { ContextMeter } from "./context-meter";

function contextPort(
  usage: { tokens: number; contextWindow: number; percent: number } | null,
): ContextUsagePort {
  const snapshot = {
    usage,
    isCompacting: false,
    autoCompactionEnabled: usage === null ? null : true,
    tokensPerSecond: usage === null ? null : 12,
    revision: "context-test",
    error: null,
  };
  return { getSnapshot: () => snapshot, subscribe: () => () => undefined };
}

function compactionPort(): { port: CompactionPort; calls: string[] } {
  const calls: string[] = [];
  const snapshot = {
    phase: "idle" as const,
    method: null,
    auto: false,
    result: null,
    error: null,
    revision: "compaction-test",
  };
  return {
    calls,
    port: {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      compact: async () => {
        calls.push("compact");
        return { summary: "done", firstKeptEntryId: "entry-1", tokensBefore: 100 };
      },
      setAutoCompaction: async ({ enabled }) => {
        calls.push(enabled ? "auto:on" : "auto:off");
      },
    },
  };
}

afterEach(cleanup);

describe("P7 context and compaction surfaces", () => {
  test("renders a meter and an explicit unavailable state instead of treating missing usage as zero", () => {
    const { rerender } = render(<ContextMeter port={contextPort(null)} />);
    expect(screen.getByText("Context usage is unavailable from this host.")).toBeTruthy();
    rerender(<ContextMeter port={contextPort({ tokens: 80, contextWindow: 100, percent: 80 })} />);
    expect(screen.getByText("80 / 100 tokens")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("80");
  });

  test("routes manual and automatic compaction actions through the typed port", () => {
    const { port, calls } = compactionPort();
    render(<CompactionControls port={port} />);
    fireEvent.click(screen.getByRole("button", { name: "Compact now" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Auto-compaction" }));
    expect(calls).toEqual(["compact", "auto:on"]);
  });
});
