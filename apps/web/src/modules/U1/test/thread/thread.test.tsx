import { AssistantRuntimeProvider, type ThreadMessageLike } from "@assistant-ui/react";
import type {
  CapabilityMap,
  EntryId,
  OmpMessage,
  RpcSessionEvent,
  RpcSessionSend,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  test("keeps the empty state inside the message list, so the list does not move when the first message replaces it", () => {
    const { container } = renderThread(readyStore());
    const list = container.querySelector('[data-slot="u1-thread-messages"]');
    expect(list?.querySelector('[data-slot="u1-thread-empty"]')).not.toBeNull();
  });

  test("names an extension's error under its own heading, not as a conversation that stopped", () => {
    const store = readyStore();
    store.ingest(
      {
        kind: "notification",
        frame: {
          type: "extension_error",
          extensionPath: "/extensions/notes-ext/index.ts",
          event: "session_start",
          error: "index is locked",
        },
      } as unknown as RpcSessionEvent,
      2,
    );
    renderThread(store);
    expect(screen.getByText("An extension reported an error")).toBeTruthy();
    expect(screen.getByText("notes-ext: index is locked")).toBeTruthy();
    expect(screen.queryByText("The conversation could not continue.")).toBeNull();
  });

  test("says the chat is loading until its history is read, then that it is empty", () => {
    const store = readyStore();
    const reading = { threadId, resumeAt: null, historyLoading: true };
    const { rerender } = renderThread(store, { readingPlace: reading });

    expect(screen.getByText("Loading conversation…")).toBeTruthy();
    expect(screen.queryByText("No messages yet.")).toBeNull();

    rerender(
      <RuntimeThread
        props={{ readingPlace: { ...reading, historyLoading: false } }}
        store={store}
      />,
    );
    expect(screen.queryByText("Loading conversation…")).toBeNull();
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

    expect(screen.getByRole("alert").textContent).toContain("The conversation could not continue.");
    expect(screen.getByRole("region", { name: "Failure details" }).textContent).toContain(
      "The runtime was blocked",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  test("offers Restart omp when omp stopped on its own, and not the generic Retry", async () => {
    const store = readyStore();
    store.ingest(
      {
        kind: "process",
        status: "exited",
        error: { code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true },
      } as RpcSessionEvent,
      2,
    );
    const restart = vi.fn(async () => undefined);
    const retry = vi.fn();
    renderThread(store, { onRestartOmp: restart, onRetry: retry });

    expect(screen.getByRole("alert").textContent).toContain("The conversation could not continue.");
    expect(screen.getByRole("region", { name: "Failure details" }).textContent).toContain(
      "omp exited (signal SIGKILL)",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restart omp" }));

    expect(restart).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Restart omp" })).toBeTruthy();
  });
  test("keeps the banner mounted with Restarting while omp starts", async () => {
    const store = readyStore();
    store.ingest(
      {
        kind: "process",
        status: "exited",
        error: { code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true },
      } as RpcSessionEvent,
      2,
    );
    const answer = Promise.withResolvers<void>();
    renderThread(store, { onRestartOmp: () => answer.promise });

    fireEvent.click(screen.getByRole("button", { name: "Restart omp" }));
    store.ingest({ kind: "process", status: "starting" } as RpcSessionEvent, 3);
    await screen.findByRole("button", { name: "Restarting…" });
    expect(screen.getByRole("region", { name: "Failure details" }).textContent).toContain(
      "omp exited (signal SIGKILL)",
    );
    expect(screen.getByText("The conversation could not continue.")).toBeTruthy();
    answer.resolve();
    store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 4);
    expect(store.getSnapshot().process.status).toBe("ready");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
  test("clears a process failure when omp becomes ready again", async () => {
    const store = readyStore();
    store.ingest(
      {
        kind: "process",
        status: "error",
        error: { code: "permission", message: "The runtime was blocked", retryable: true },
      } as RpcSessionEvent,
      2,
    );
    renderThread(store, { onRetry: vi.fn() });
    expect(screen.getByRole("alert")).toBeTruthy();
    store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 3);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
  test("clears the source failure after a rejected restart recovers", async () => {
    const store = readyStore();
    store.ingest(
      {
        kind: "process",
        status: "exited",
        error: { code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true },
      } as RpcSessionEvent,
      2,
    );
    const restart = vi.fn(async () => {
      throw new AppFailure({
        code: "timeout",
        message: "The restart timed out",
        retryable: true,
      });
    });
    renderThread(store, { onRestartOmp: restart, onRetry: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: "Restart omp" }));
    expect(await screen.findByText("The restart timed out", { exact: true })).toBeTruthy();
    expect(screen.getByText("The conversation could not continue.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart omp" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 3);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  test("clears a stopped omp banner when it starts again without a button click", async () => {
    const store = readyStore();
    store.ingest(
      {
        kind: "process",
        status: "exited",
        error: { code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true },
      } as RpcSessionEvent,
      2,
    );
    renderThread(store, { onRestartOmp: vi.fn(async () => undefined) });
    expect(screen.getByRole("alert")).toBeTruthy();
    store.ingest({ kind: "process", status: "starting" } as RpcSessionEvent, 3);
    store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 4);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  test("does not carry one chat's restarting failure into another chat", async () => {
    const failed = readyStore();
    failed.ingest(
      {
        kind: "process",
        status: "exited",
        error: { code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true },
      } as RpcSessionEvent,
      2,
    );
    const other = new OmpRuntimeStore({ threadId: "other-thread" as ThreadId });
    expect(other.getSnapshot().process.status).toBe("starting");
    const restart = Promise.withResolvers<void>();
    const view = renderThread(failed, { onRestartOmp: () => restart.promise });

    fireEvent.click(screen.getByRole("button", { name: "Restart omp" }));
    failed.ingest({ kind: "process", status: "starting" } as RpcSessionEvent, 3);
    await screen.findByRole("button", { name: "Restarting…" });
    expect(screen.getByRole("region", { name: "Failure details" }).textContent).toContain(
      "omp exited (signal SIGKILL)",
    );

    view.rerender(<RuntimeThread props={{}} store={other} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Restarting…" })).toBeNull();
  });

  test("puts a stopped omp's notice in the footer, after the last message", async () => {
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
    store.ingest(
      {
        kind: "process",
        status: "exited",
        error: { code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true },
      } as RpcSessionEvent,
      4,
    );
    renderThread(store, { onRestartOmp: vi.fn(async () => undefined) });

    expect(await screen.findByText("hello")).toBeTruthy();
    const banner = screen.getByRole("alert");
    const footer = document.querySelector('[data-slot="u1-thread-footer"]');
    const messages = document.querySelector('[data-slot="u1-thread-messages"]');
    // The notice sits in the sticky footer, where the reader is, and not above the first message.
    expect(footer?.contains(banner)).toBe(true);
    expect(messages?.contains(banner)).toBe(false);
    expect(screen.getByRole("button", { name: "Restart omp" })).toBeTruthy();
  });

  test("says plainly why omp could not be restarted and takes the button away when it can never work", async () => {
    const store = readyStore();
    store.ingest(
      {
        kind: "process",
        status: "exited",
        error: { code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true },
      } as RpcSessionEvent,
      2,
    );
    const restart = vi.fn(async () => {
      throw new AppFailure({
        code: "omp_exited",
        message:
          "omp stopped before this chat was saved, so it can't be continued. Start a new chat.",
        retryable: false,
      });
    });
    renderThread(store, { onRestartOmp: restart });

    fireEvent.click(screen.getByRole("button", { name: "Restart omp" }));

    expect(await screen.findByText(/before this chat was saved/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart omp" })).toBeNull();
    expect(restart).toHaveBeenCalledOnce();
  });

  test("keeps the button when omp could not be restarted for a reason that may pass", async () => {
    const store = readyStore();
    store.ingest(
      {
        kind: "process",
        status: "exited",
        error: { code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true },
      } as RpcSessionEvent,
      2,
    );
    const restart = vi.fn(async () => {
      throw new AppFailure({
        code: "omp_exited",
        message: "omp could not start",
        retryable: true,
      });
    });
    renderThread(store, { onRestartOmp: restart });

    fireEvent.click(screen.getByRole("button", { name: "Restart omp" }));

    expect(await screen.findByText("omp could not start")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart omp" })).toBeTruthy();
  });

  test("shows no restart action for an omp failure that is not an exit", () => {
    const store = readyStore();
    store.ingest(
      {
        kind: "process",
        status: "error",
        error: { code: "permission", message: "The runtime was blocked", retryable: true },
      } as RpcSessionEvent,
      2,
    );
    renderThread(store, { onRestartOmp: vi.fn() });

    expect(screen.queryByRole("button", { name: "Restart omp" })).toBeNull();
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
          message: assistant("firstsecond"),
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "second",
            partial: assistant("firstsecond"),
          },
        },
      },
      3,
    );
    expect(document.querySelectorAll('[data-slot="u1-thread-message"]')).toHaveLength(1);
    expect(await screen.findByText("firstsecond")).toBeTruthy();
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
    const region = screen.getByRole("group", { name: "1 message in nested transcript" });
    expect(region.getAttribute("data-read-only")).toBe("true");
    expect(region.querySelector("button")).toBeNull();
  });
});

function historyMessage(
  id: string,
  parentId: string | null,
  text: string,
): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-05T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: 1 },
  };
}

describe("ThreadShell earlier messages", () => {
  test("pages older history in on click and removes the control once nothing is older", async () => {
    const store = readyStore();
    store.pairEndedMessages([historyMessage("newer", "older", "newest text")], "newer" as EntryId);
    store.setHasOlder(true);
    const loadOlder = vi.fn(async () => {
      store.prependHistoryEntries([historyMessage("older", null, "oldest text")], false);
    });
    renderThread(store, { onLoadOlder: loadOlder });

    expect(screen.queryByText("newest text")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show earlier messages" }));
    await waitFor(() => expect(screen.queryByText("oldest text")).not.toBeNull());

    expect(loadOlder).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Show earlier messages" })).toBeNull();
  });

  test("stays hidden while the store holds no older history", () => {
    const store = readyStore();
    store.pairEndedMessages([historyMessage("only", null, "only text")], "only" as EntryId);
    renderThread(store, { onLoadOlder: vi.fn(async () => {}) });

    expect(screen.queryByRole("button", { name: "Show earlier messages" })).toBeNull();
  });

  test("stays hidden when the shell has no way to load older history", () => {
    const store = readyStore();
    store.pairEndedMessages([historyMessage("only", null, "only text")], "only" as EntryId);
    store.setHasOlder(true);
    renderThread(store);

    expect(screen.queryByRole("button", { name: "Show earlier messages" })).toBeNull();
  });

  test("reports a failed page to the reader and keeps the control available", async () => {
    const store = readyStore();
    store.pairEndedMessages([historyMessage("newer", "older", "newest text")], "newer" as EntryId);
    store.setHasOlder(true);
    renderThread(store, {
      onLoadOlder: async () => {
        throw new AppFailure({
          code: "omp_error",
          message: "The older page could not be read",
          retryable: true,
        });
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Show earlier messages" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("The older page could not be read"),
    );
    expect(screen.getByRole("button", { name: "Show earlier messages" })).toBeTruthy();
  });

  test("moves focus to the transcript when the last older page loads", async () => {
    const store = readyStore();
    store.pairEndedMessages([historyMessage("newer", "older", "newest text")], "newer" as EntryId);
    store.setHasOlder(true);
    renderThread(store, {
      onLoadOlder: async () => {
        store.prependHistoryEntries([historyMessage("older", null, "oldest text")], false);
      },
    });

    const button = screen.getByRole("button", { name: "Show earlier messages" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Show earlier messages" })).toBeNull(),
    );

    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Messages" }));
  });
});
