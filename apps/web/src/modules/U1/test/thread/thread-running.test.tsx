// The thread's root says a run is on while one is, and a run that starts or ends draws no row whose message did not change.
// A run adds its own placeholder row and flips the last message's position, so those rows may draw; the earlier rows,
// whose messages did not change, must not.

import { AssistantRuntimeProvider, type MessageState } from "@assistant-ui/react";
import type {
  CapabilityMap,
  ChatSessionEvent,
  ChatSessionRequest,
  OmpMessage,
  ThreadId,
} from "@omp-app/contracts";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ompEvent } from "@/modules/R0/store/session-events";
import { useOmpRuntime } from "../../../R0/runtime";
import { OmpRuntimeStore } from "../../../R0/store";
import { type ThreadRowSlots, ThreadShell } from "../../thread";

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
});

const threadId = "u1-thread-running" as ThreadId;
// Module scope: the runtime's options keep their identity, so the chat is not rebuilt between renders.
const capabilities: CapabilityMap = { "omp.cmd.prompt": { state: "available", via: "omp" } };
const send: ChatSessionRequest = async () => undefined as never;
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function assistant(text: string): OmpMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage,
    stopReason: "stop",
    timestamp: 1_759_600_000_000,
  } as unknown as OmpMessage;
}

function user(text: string): OmpMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1_759_600_000_000,
  } as unknown as OmpMessage;
}

/** One message per text, alternating from a user message; the chat has finished its last run. */
function transcript(texts: readonly string[]): OmpRuntimeStore {
  const store = new OmpRuntimeStore({ threadId });
  store.ingest({ kind: "process", status: "ready" } as ChatSessionEvent, 1);
  texts.forEach((text, index) => {
    const messageId = `m-${index}`;
    const message = index % 2 === 0 ? user(text) : assistant(text);
    store.ingest(
      ompEvent({ type: "message_start", messageId, message }),
      store.getSnapshot().lastSeq + 1,
    );
    store.ingest(
      ompEvent({ type: "message_end", messageId, message }),
      store.getSnapshot().lastSeq + 1,
    );
  });
  store.ingest(ompEvent({ type: "agent_end", messages: [] }), store.getSnapshot().lastSeq + 1);
  return store;
}

function Thread({
  store,
  slots,
}: {
  readonly store: OmpRuntimeStore;
  readonly slots: ThreadRowSlots;
}) {
  const { runtime } = useOmpRuntime({ store, send, capabilities });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadShell slots={slots} store={store} />
    </AssistantRuntimeProvider>
  );
}

/** A row slot that draws each row's text and records each draw. The slots are built once per drawn list. */
function Chat({ store, drawn }: { readonly store: OmpRuntimeStore; readonly drawn: string[] }) {
  const slots = useMemo<ThreadRowSlots>(
    () => ({
      renderMessage: (message: MessageState) => {
        const text = message.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        drawn.push(text);
        return <p>{text}</p>;
      },
    }),
    [drawn],
  );
  return <Thread slots={slots} store={store} />;
}

function threadRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="u1-thread-root"]');
}

describe("U1 thread root says a run is on, and a run's start or end draws no earlier row", () => {
  test("the root carries data-thread-running while a run is on, and not once it has ended", async () => {
    const store = transcript(["alpha", "bravo", "charlie"]);
    render(<Chat drawn={[]} store={store} />);
    await waitFor(() => expect(threadRoot()).not.toBeNull());
    expect(threadRoot()?.getAttribute("data-thread-running")).toBeNull();

    act(() => {
      store.ingest(ompEvent({ type: "agent_start" }), store.getSnapshot().lastSeq + 1);
    });
    await waitFor(() => expect(threadRoot()?.getAttribute("data-thread-running")).toBe("true"));

    act(() => {
      store.ingest(ompEvent({ type: "agent_end", messages: [] }), store.getSnapshot().lastSeq + 1);
    });
    await waitFor(() => expect(threadRoot()?.getAttribute("data-thread-running")).toBeNull());
  });

  test("a run that starts or ends draws no row whose message did not change", async () => {
    const earlier = ["alpha", "bravo"];
    const store = transcript([...earlier, "charlie"]);
    const drawn: string[] = [];
    render(<Chat drawn={drawn} store={store} />);
    await waitFor(() => expect(new Set(drawn).size).toBe(3));
    await act(async () => {
      await sleep(100);
    });
    drawn.length = 0;

    act(() => {
      store.ingest(ompEvent({ type: "agent_start" }), store.getSnapshot().lastSeq + 1);
    });
    await act(async () => {
      await sleep(200);
    });
    expect(drawn.filter((text) => earlier.includes(text))).toEqual([]);

    drawn.length = 0;
    act(() => {
      store.ingest(ompEvent({ type: "agent_end", messages: [] }), store.getSnapshot().lastSeq + 1);
    });
    await act(async () => {
      await sleep(200);
    });
    expect(drawn.filter((text) => earlier.includes(text))).toEqual([]);
  });
});
