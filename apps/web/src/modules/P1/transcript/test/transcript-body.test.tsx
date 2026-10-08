import type { ThreadMessageLike } from "@assistant-ui/react";
import { ThreadPrimitive } from "@assistant-ui/react";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToolFallback } from "@/modules/U3/tool-card/fallback";
import type { TranscriptView } from "../controller";
import { ReadOnlyThread } from "../read-only-thread";
import { AgentTranscriptBody } from "../transcript-body";

const originalScrollTo = HTMLElement.prototype.scrollTo;

beforeEach(() => {
  // The transcript's viewport needs these browser APIs; jsdom has neither.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: originalScrollTo,
  });
});

function InThread({ children }: { readonly children: ReactNode }) {
  return (
    <ReadOnlyThread messages={[]}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Viewport>{children}</ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </ReadOnlyThread>
  );
}

/** A worker's message that asked for two calls (a bash, then a write), and their results were never recorded. */
const messages: ThreadMessageLike[] = [
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "worker-bash",
        toolName: "bash",
        args: { command: "sleep 9" },
        argsText: '{"command":"sleep 9"}',
      },
      {
        type: "tool-call",
        toolCallId: "worker-write",
        toolName: "write",
        args: { path: "x.txt", content: "y" },
        argsText: '{"path":"x.txt","content":"y"}',
      },
    ],
    status: { type: "complete", reason: "stop" },
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "Waiting for the bash." }],
    status: { type: "complete", reason: "stop" },
  },
];

function view(agentStatus: TranscriptView["agentStatus"]): TranscriptView {
  return {
    messages,
    loading: false,
    failure: undefined,
    liveFailure: undefined,
    agentStatus,
    refresh: () => undefined,
  } as unknown as TranscriptView;
}

describe("a worker's calls with no result", () => {
  test("a live worker's queued calls read Waiting, and a finished worker's read Finished", () => {
    const renderers = { bash: ToolFallback, write: ToolFallback };
    const { unmount } = render(
      <InThread>
        <AgentTranscriptBody
          depth={0}
          taskName="Worker"
          toolRenderers={renderers}
          transcript={view("running")}
        />
      </InThread>,
    );
    expect(screen.getAllByTestId("tool-state-chip-partial").length).toBe(2);
    expect(screen.queryByText("No result recorded")).toBeNull();
    unmount();

    render(
      <InThread>
        <AgentTranscriptBody
          depth={0}
          taskName="Worker"
          toolRenderers={renderers}
          transcript={view("completed")}
        />
      </InThread>,
    );
    expect(screen.getAllByTestId("tool-state-chip-unrecorded").length).toBe(2);
    expect(screen.getAllByText("No result recorded").length).toBeGreaterThan(0);
  });
});
