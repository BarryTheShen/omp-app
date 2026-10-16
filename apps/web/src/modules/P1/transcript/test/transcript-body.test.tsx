import type { ThreadMessageLike } from "@assistant-ui/react";
import { ThreadPrimitive } from "@assistant-ui/react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProviderErrorResolverProvider } from "@/modules/U1/parts/provider-error-resolver";
import { ToolRendererResolverContext } from "@/modules/U1/tool-slots";
import { ToolFallback } from "@/modules/U3/tool-card/fallback";
import { createToolRegistry } from "@/modules/U3/tool-card/registry";
import { TOOL_RENDERERS } from "@/registry";
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

function view(
  agentStatus: TranscriptView["agentStatus"],
  list: ThreadMessageLike[] = messages,
): TranscriptView {
  return {
    messages: list,
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

  test("a finished worker's cut-off write reads No result recorded in the app's own write card; a live worker's does not", () => {
    // The transcript resolves each tool through the same registry the chat uses, so the card is the app's write card.
    const registry = createToolRegistry(TOOL_RENDERERS);
    const resolve = (toolName: string) => registry.resolve(toolName).renderer;
    const cutOff: ThreadMessageLike[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "worker-cut-write",
            toolName: "write",
            args: { path: "notes.txt", content: "a note" },
            argsText: '{"path":"notes.txt","content":"a note"}',
          },
        ],
        status: { type: "complete", reason: "stop" },
      },
    ];
    const { unmount } = render(
      <ToolRendererResolverContext.Provider value={resolve}>
        <InThread>
          <AgentTranscriptBody depth={0} taskName="Worker" transcript={view("completed", cutOff)} />
        </InThread>
      </ToolRendererResolverContext.Provider>,
    );
    const card = screen.getByTestId("t1-write-card");
    expect(within(card).getByTestId("tool-state-chip-unrecorded").textContent).toContain(
      "Finished",
    );
    expect(within(card).getAllByText("No result recorded").length).toBeGreaterThan(0);
    expect(card.querySelector('[data-phase="error"]')).toBeNull();
    expect(card.querySelector('[role="alert"]')).toBeNull();
    expect(card.querySelector('[class*="success"]')).toBeNull();
    unmount();

    render(
      <ToolRendererResolverContext.Provider value={resolve}>
        <InThread>
          <AgentTranscriptBody depth={0} taskName="Worker" transcript={view("running", cutOff)} />
        </InThread>
      </ToolRendererResolverContext.Provider>,
    );
    expect(screen.queryByText("No result recorded")).toBeNull();
    expect(screen.queryByTestId("tool-state-chip-unrecorded")).toBeNull();
  });
  test("a worker error uses the typed resolver and never renders omp's request-log path", async () => {
    const requestPath = "/example/omp-home/logs/http-400-requests/request.json";
    const providerWords = "400 worker provider failure";
    const raw = `${providerWords}\n${providerWords} (type=invalid_request_error)\nraw-http-request=${requestPath}`;
    const message: ThreadMessageLike = {
      role: "assistant",
      content: [{ type: "text", text: "The answer stopped." }],
      status: { type: "incomplete", reason: "error", error: raw },
    };
    const resolveProviderError = vi.fn(async () => ({
      message: `${providerWords} (type=invalid_request_error)`,
    }));
    const renderers = { bash: ToolFallback, write: ToolFallback };

    render(
      <ProviderErrorResolverProvider resolver={resolveProviderError}>
        <ToolRendererResolverContext.Provider value={(toolName) => renderers[toolName as "bash"]}>
          <InThread>
            <AgentTranscriptBody
              depth={0}
              taskName="Worker"
              toolRenderers={renderers}
              transcript={view("completed", [message])}
            />
          </InThread>
        </ToolRendererResolverContext.Provider>
      </ProviderErrorResolverProvider>,
    );

    await waitFor(() => expect(resolveProviderError).toHaveBeenCalledWith(raw));
    await waitFor(() =>
      expect(document.body.textContent).toContain(`${providerWords} (type=invalid_request_error)`),
    );
    const text = document.body.textContent ?? "";
    expect(text.split(providerWords).length).toBe(2);
    expect(text).not.toContain(requestPath);
    expect(text).not.toContain("raw-http-request=");
  });
});
