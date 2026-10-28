import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "@/shell";
import {
  P6_QUEUE_CAPABILITIES,
  type QueueModeChanges,
  type QueuePort,
  type QueueSnapshot,
} from "../contract";
import { QueueModeSelector } from "./mode-selector";

function createFixturePort(): QueuePort {
  let snapshot: QueueSnapshot = {
    steering: ["Fix the failing test"],
    followUp: ["Summarize after yield"],
    steeringMode: "one-at-a-time",
    followUpMode: "all",
    interruptMode: "immediate",
    isStreaming: true,
  };
  const listeners = new Set<(value: QueueSnapshot) => void>();
  return {
    getSnapshot: () => snapshot,
    getCapabilities: () => ({
      [P6_QUEUE_CAPABILITIES.steeringMode]: { state: "available", via: "omp" },
      [P6_QUEUE_CAPABILITIES.followUpMode]: { state: "available", via: "omp" },
      [P6_QUEUE_CAPABILITIES.interruptMode]: { state: "available", via: "omp" },
    }),
    subscribe: (listener: (value: QueueSnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setModes: async (changes: QueueModeChanges) => {
      snapshot = { ...snapshot, ...changes };
      for (const listener of listeners) listener(snapshot);
    },
  } as unknown as QueuePort;
}

function ModePlayground() {
  const port = useMemo(() => createFixturePort(), []);
  const [open, setOpen] = useState(false);
  return (
    <AppShell
      leftSidebar={<div className="p-4 text-xs">Queue fixture</div>}
      rightSidebar={<div className="p-4 text-xs">Session queue</div>}
      threadHeader={
        <button
          className="border-border bg-background hover:bg-muted rounded-md border px-3 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          type="button"
          onClick={() => setOpen(true)}
        >
          Queue modes
        </button>
      }
      transcript={
        <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 px-6 py-8">
          <h1 className="text-lg font-semibold">Queue mode selector</h1>
          <p className="text-muted-foreground text-sm">
            Modes are session-scoped. Steering controls the active turn; queued follow-ups wait for
            it to finish.
          </p>
          <QueueModeSelector onOpenChange={setOpen} open={open} port={port} />
        </div>
      }
    />
  );
}

const root = document.getElementById("p6-mode-playground-root");
if (!root) throw new Error("P6 mode playground root is missing.");
createRoot(root).render(<ModePlayground />);
