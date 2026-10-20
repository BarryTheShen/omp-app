// A message row is drawn again only when its message changes, or when a value its slots read changes. The rows here are
// drawn through a slot that records each draw, so a row the thread skips is a row that is not recorded. The rows render
// asynchronously, so each test waits for the rows it is about before it asserts on draws.
import { AssistantRuntimeProvider, type MessageState } from "@assistant-ui/react";
import type {
  CapabilityMap,
  OmpMessage,
  RpcSessionEvent,
  RpcSessionSend,
  ThreadId,
} from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useOmpRuntime } from "../../../R0/runtime";
import { OmpRuntimeStore } from "../../../R0/store";
import {
  MemoryThinkingVisibilityStore,
  TranscriptDisplayPolicyProvider,
  useTranscriptDisplayPolicy,
} from "../../policy";
import { type ThreadRowSlots, ThreadShell } from "../../thread";

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

const threadId = "u1-row-memo" as ThreadId;
const capabilities: CapabilityMap = {
  "omp.cmd.prompt": { state: "available", via: "rpc" },
};
const send: RpcSessionSend = async () => undefined as never;
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(text: string): Extract<OmpMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage,
    stopReason: "stop",
    timestamp: 1_759_600_000_000,
  };
}

/** A user message, as omp writes one. The text is the row's text. */
function user(text: string): OmpMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1_759_600_000_000,
  } as unknown as OmpMessage;
}

/**
 * A chat of messages, one per text, alternating from a user message: two answers in a row would join into one row. The
 * last message is still streaming when `lastStreaming` is set.
 */
function transcript(texts: readonly string[], lastStreaming = false): OmpRuntimeStore {
  const store = new OmpRuntimeStore({ threadId });
  store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 1);
  texts.forEach((text, index) => {
    const messageId = `m-${index}`;
    const message = index % 2 === 0 ? user(text) : assistant(text);
    store.ingest(
      { kind: "omp", event: { type: "message_start", messageId, message } },
      2 + index * 2,
    );
    if (!(lastStreaming && index === texts.length - 1)) {
      store.ingest(
        { kind: "omp", event: { type: "message_end", messageId, message } },
        3 + index * 2,
      );
    }
  });
  if (!lastStreaming)
    store.ingest({ kind: "omp", event: { type: "agent_end", messages: [] } }, 2 + texts.length * 2);
  return store;
}

function textOf(message: MessageState): string {
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
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

/** A row slot that draws each row's text, the last user answer's marker and the edit marker, and records each draw. */
function markedSlots(drawn: string[], lastUser: string, branching: boolean): ThreadRowSlots {
  return {
    renderMessage: (message) => {
      const text = textOf(message);
      drawn.push(text);
      return (
        <p data-row={text}>
          {text}
          {lastUser === text ? " · last user" : ""}
          {branching ? " · edit" : ""}
        </p>
      );
    },
  };
}

/** The chat as the app builds it: the slots are rebuilt only when the values they read change. */
function Chat({
  store,
  drawn,
  lastUser,
  branching,
}: {
  readonly store: OmpRuntimeStore;
  readonly drawn: string[];
  readonly lastUser: string;
  readonly branching: boolean;
}) {
  const slots = useMemo(
    () => markedSlots(drawn, lastUser, branching),
    [drawn, lastUser, branching],
  );
  return <Thread slots={slots} store={store} />;
}

/** Waits until every named row has been drawn at least once. */
async function untilDrawn(drawn: readonly string[], texts: readonly string[]): Promise<void> {
  await waitFor(() => {
    for (const text of texts) expect(drawn).toContain(text);
  });
}

describe("U1 message rows are drawn again only when their message or a value their slots read changes", () => {
  test("a row is drawn again when its message changes, and the rows above it are not", async () => {
    const store = transcript(["alpha", "bravo"], true);
    const drawn: string[] = [];
    render(<Chat branching={false} drawn={drawn} lastUser="" store={store} />);
    await untilDrawn(drawn, ["alpha", "bravo"]);
    drawn.length = 0;

    act(() => {
      store.ingest(
        {
          kind: "omp",
          event: {
            type: "message_update",
            messageId: "m-1",
            message: assistant("bravo again"),
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: " again",
              partial: assistant("bravo again"),
            },
          },
        },
        5,
      );
    });

    expect(await screen.findByText("bravo again")).toBeTruthy();
    await untilDrawn(drawn, ["bravo again"]);
    expect(new Set(drawn)).toEqual(new Set(["bravo again"]));
  });

  test("every row is drawn again when a value its slots read changes, such as the last user message", async () => {
    const texts = ["alpha", "bravo", "charlie"];
    const store = transcript(texts);
    const drawn: string[] = [];
    const view = render(<Chat branching={false} drawn={drawn} lastUser="bravo" store={store} />);
    await untilDrawn(drawn, texts);
    drawn.length = 0;

    view.rerender(<Chat branching={false} drawn={drawn} lastUser="charlie" store={store} />);

    await untilDrawn(drawn, texts);
    expect(screen.getByText(/^charlie/).textContent).toContain("last user");
    expect(screen.getByText(/^bravo/).textContent).not.toContain("last user");
  });

  test("every row is drawn again when branching becomes available", async () => {
    const texts = ["alpha", "bravo"];
    const store = transcript(texts);
    const drawn: string[] = [];
    const view = render(<Chat branching={false} drawn={drawn} lastUser="" store={store} />);
    await untilDrawn(drawn, texts);
    expect(screen.getByText(/^alpha/).textContent).not.toContain("edit");
    drawn.length = 0;

    view.rerender(<Chat branching drawn={drawn} lastUser="" store={store} />);

    await untilDrawn(drawn, texts);
    expect(screen.getByText(/^alpha/).textContent).toContain("edit");
  });

  test("no row is drawn again when the chat renders again with the same values", async () => {
    const texts = ["alpha", "bravo"];
    const store = transcript(texts);
    const drawn: string[] = [];
    const view = render(<Chat branching={false} drawn={drawn} lastUser="bravo" store={store} />);
    await untilDrawn(drawn, texts);
    drawn.length = 0;

    view.rerender(<Chat branching={false} drawn={drawn} lastUser="bravo" store={store} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/^bravo/)).toBeTruthy();
    expect(drawn).toEqual([]);
  });
});

/** A tool-call display policy read inside each row through its context, as the tool cards read it. */
function PolicyLabel() {
  const { tools } = useTranscriptDisplayPolicy();
  return <span data-policy="">{tools}</span>;
}

function ToolsToggle() {
  const { toggleTools } = useTranscriptDisplayPolicy();
  return (
    <button onClick={toggleTools} type="button">
      Toggle tools
    </button>
  );
}

describe("U1 message rows follow the tool-call display policy they read", () => {
  test("each row shows a changed policy without being drawn again", async () => {
    const store = transcript(["alpha", "bravo"]);
    let draws = 0;
    const slots: ThreadRowSlots = {
      renderMessage: (message) => {
        draws += 1;
        return (
          <p>
            {textOf(message)} <PolicyLabel />
          </p>
        );
      },
    };
    render(
      <TranscriptDisplayPolicyProvider
        storage={new MemoryThinkingVisibilityStore()}
        threadId={String(threadId)}
      >
        <ToolsToggle />
        <Thread slots={slots} store={store} />
      </TranscriptDisplayPolicyProvider>,
    );
    const labels = () =>
      Array.from(document.querySelectorAll("[data-policy]"), (node) => node.textContent);
    await waitFor(() => expect(labels()).toEqual(["visible", "visible"]));
    const drawnBefore = draws;

    fireEvent.click(screen.getByRole("button", { name: "Toggle tools" }));

    await waitFor(() => expect(labels()).toEqual(["hidden", "hidden"]));
    expect(draws).toBe(drawnBefore);
  });
});
