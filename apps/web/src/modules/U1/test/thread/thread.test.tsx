import { AssistantRuntimeProvider, type ThreadMessageLike } from "@assistant-ui/react";
import type {
  CapabilityMap,
  OmpMessage,
  RpcSessionEvent,
  RpcSessionSend,
  ThreadId,
} from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createRegistry, RegistryProvider, registerRenderers } from "@/registry-core";
import { useOmpRuntime } from "../../../R0/runtime";
import { OmpRuntimeStore } from "../../../R0/store";
import { U1MessageDescriptors } from "../../registry/messages";
import type { ThreadShellProps } from "../../thread";
import { ReadOnlyNestedTranscript, ThreadShell } from "../../thread";

const originalScrollTo = HTMLElement.prototype.scrollTo;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: originalScrollTo,
  });
});

const threadId = "u1-thread-test" as ThreadId;
const capabilities: CapabilityMap = {
  "omp.cmd.prompt": { state: "available", via: "rpc" },
  "omp.cmd.abort": { state: "available", via: "rpc" },
};
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  text: string,
  stopReason: "stop" | "error" = "stop",
): Extract<OmpMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage,
    stopReason,
    timestamp: 1_759_600_000_000,
  };
}

function send(): RpcSessionSend {
  return async () => undefined as never;
}
const testSend = send();

function readyStore(): OmpRuntimeStore {
  const store = new OmpRuntimeStore({ threadId });
  store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 1);
  return store;
}
function RuntimeThread({
  store,
  props,
}: {
  readonly store: OmpRuntimeStore;
  readonly props: Partial<ThreadShellProps>;
}) {
  const { runtime } = useOmpRuntime({ store, send: testSend, capabilities });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadShell {...props} store={store} />
    </AssistantRuntimeProvider>
  );
}

function renderThread(store: OmpRuntimeStore, props: Partial<ThreadShellProps> = {}) {
  return render(<RuntimeThread props={props} store={store} />);
}

describe("ThreadShell states", () => {
  test("renders a recoverable loading state while the process starts", () => {
    const store = new OmpRuntimeStore({ threadId });
    renderThread(store);
    expect(screen.getByRole("status").textContent).toContain("Loading conversation");
  });

  test("renders an explicit empty state after a ready process has no messages", () => {
    renderThread(readyStore());
    expect(screen.getByText("No messages yet.")).toBeTruthy();
  });

  test("renders a safe AppFailure state with a retry action", () => {
    const store = readyStore();
    store.ingest(
      {
        kind: "process",
        status: "error",
        error: { code: "permission", message: "The runtime was blocked", retryable: true },
      } as RpcSessionEvent,
      2,
    );
    const retry = vi.fn();
    renderThread(store, { onRetry: retry });

    expect(screen.getByRole("alert").textContent).toContain("The runtime was blocked");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  test("renders a settled status after a real store message", async () => {
    const store = readyStore();
    store.ingest(
      {
        kind: "omp",
        event: { type: "message_start", messageId: "m-1", message: assistant("hello") },
      },
      2,
    );
    store.ingest(
      {
        kind: "omp",
        event: { type: "message_end", messageId: "m-1", message: assistant("hello") },
      },
      3,
    );
    store.ingest({ kind: "omp", event: { type: "agent_end", messages: [] } }, 4);
    renderThread(store);
    expect(await screen.findByText("hello")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Conversation settled");
  });

  test("keeps one stable row while the store replaces a streaming message", async () => {
    const store = new OmpRuntimeStore({ threadId });
    store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 1);
    store.ingest(
      {
        kind: "omp",
        event: {
          type: "message_start",
          messageId: "m-stream",
          message: assistant("first"),
        },
      },
      2,
    );
    const view = renderThread(store);
    expect(document.querySelectorAll('[data-slot="u1-thread-message"]')).toHaveLength(1);
    store.ingest(
      {
        kind: "omp",
        event: {
          type: "message_update",
          messageId: "m-stream",
          message: assistant("second"),
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "second",
            partial: assistant("second"),
          },
        },
      },
      3,
    );
    expect(document.querySelectorAll('[data-slot="u1-thread-message"]')).toHaveLength(1);
    expect(await screen.findByText("second")).toBeTruthy();
    view.unmount();
  });
});

describe("descriptor and nested row slots", () => {
  test("uses a registered U0 renderer by descriptor and otherwise keeps the default row", () => {
    const store = readyStore();
    store.ingest(
      {
        kind: "omp",
        event: { type: "message_start", messageId: "m-2", message: assistant("hello") },
      },
      2,
    );
    const registry = createRegistry(U1MessageDescriptors);
    const renderers = registerRenderers({
      "U1.assistantMessage": ({ descriptor }) => (
        <div data-slot="custom-assistant-row">Registered: {descriptor.title}</div>
      ),
    });

    render(
      <RegistryProvider capabilities={capabilities} registry={registry} renderers={renderers}>
        <RuntimeThread props={{}} store={store} />
      </RegistryProvider>,
    );
    expect(document.querySelector('[data-slot="custom-assistant-row"]')?.textContent).toContain(
      "Registered: Assistant message",
    );
  });

  test("exposes a read-only nested transcript slot without adding controls", () => {
    const nested: readonly ThreadMessageLike[] = [
      { role: "assistant", id: "nested-1", content: "Nested" },
    ];
    render(
      <ReadOnlyNestedTranscript messages={nested}>
        <span>Nested</span>
      </ReadOnlyNestedTranscript>,
    );
    const region = screen.getByRole("group", { name: "1 nested messages" });
    expect(region.getAttribute("data-read-only")).toBe("true");
    expect(region.querySelector("button")).toBeNull();
  });
});
