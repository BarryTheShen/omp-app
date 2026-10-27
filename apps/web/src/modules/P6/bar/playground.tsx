import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  createQueueAdapter,
  P6_QUEUE_CAPABILITIES,
  type QueuePort,
  type QueueSnapshot,
} from "../contract";
import { QueueLaneBar } from "./bar";

const initialSnapshot: QueueSnapshot = {
  steering: ["Fix the failing test", "Steer the next tool"],
  followUp: ["Summarize the changes after yield"],
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  interruptMode: "wait",
  isStreaming: true,
  liveSteered: 1,
};

function createFixturePort(): QueuePort {
  const snapshot = initialSnapshot;
  const listeners = new Set<(next: QueueSnapshot) => void>();
  return {
    getSnapshot: () => snapshot,
    getCapabilities: () => ({
      [P6_QUEUE_CAPABILITIES.remove]: { state: "available", via: "rpc" },
      [P6_QUEUE_CAPABILITIES.promote]: { state: "available", via: "rpc" },
    }),
    subscribe: (listener: (next: QueueSnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submit: async () => undefined,
    promote: async () => ({ changed: true }),
    setModes: async () => undefined,
    answerDialog: async () => undefined,
    answerHostTool: async () => undefined,
    updateHostTool: async () => true,
    answerHostUri: async () => undefined,
    onAddToolResult: async () => undefined,
  } as unknown as QueuePort;
}

function Playground() {
  const controller = createQueueAdapter(createFixturePort());
  return (
    <main className="min-h-dvh bg-background px-(--space-lg) py-(--space-xl) text-foreground">
      <h1 className="mx-auto mb-(--space-lg) max-w-3xl text-lg font-semibold">Queue preview</h1>
      <QueueLaneBar controller={controller} />
    </main>
  );
}

const root = document.getElementById("p6-bar-playground-root");
if (!root) throw new Error("P6 bar playground root is missing.");
createRoot(root).render(
  <StrictMode>
    <Playground />
  </StrictMode>,
);
