import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { OmpMessage, RpcSessionEvent, RpcSessionSend, ThreadId } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useOmpRuntime } from "../../../R0/runtime";
import { OmpRuntimeStore } from "../../../R0/store";
import { FilePart, ImagePart, MessageParts, SourcePart } from "../../parts";
import { ThreadShell } from "../../thread";

const originalScrollTo = HTMLElement.prototype.scrollTo;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: originalScrollTo,
  });
});

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

const threadId = "u1-parts-test" as ThreadId;
const assistantCapabilities = {
  "omp.cmd.prompt": { state: "available" as const, via: "rpc" as const },
};
const assistantMessage = (
  role: "user" | "assistant" | "developer",
  content: string | readonly Record<string, unknown>[],
): OmpMessage => {
  if (role === "user" || role === "developer") {
    return { role, content, timestamp: 1_759_600_000_000 } as unknown as OmpMessage;
  }
  return {
    role,
    content,
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1_759_600_000_000,
  } as unknown as OmpMessage;
};

function send(): RpcSessionSend {
  return async () => undefined as never;
}
const testSend = send();
function RuntimeThread({
  actions,
  store,
}: {
  readonly actions?: ReactNode;
  readonly store: OmpRuntimeStore;
}) {
  const { runtime } = useOmpRuntime({
    store,
    send: testSend,
    capabilities: assistantCapabilities,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadShell
        slots={{ renderMessage: (message) => <MessageParts actions={actions} message={message} /> }}
        store={store}
      />
    </AssistantRuntimeProvider>
  );
}

describe("U1.3 standalone parts", () => {
  test("renders safe image, file, and source boundaries", () => {
    render(
      <>
        <ImagePart alt="Fixture image" src="data:image/svg+xml,%3Csvg/%3E" />
        <ImagePart alt="Blocked image" src="javascript:alert(1)" />
        <FilePart detail="2 KB" name="notes.txt" />
        <SourcePart detail="Documentation" title="Reference" url="https://example.test/docs" />
        <SourcePart title="Untrusted" url="javascript:alert(1)" />
      </>,
    );

    expect(screen.getByAltText("Fixture image")).toBeTruthy();
    expect(screen.getByText("Image unavailable.")).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Reference" }).getAttribute("href")).toBe(
      "https://example.test/docs",
    );
    expect(screen.getByText("Untrusted").tagName).toBe("SPAN");
  });

  test("uses the user bubble surface while assistant rows remain full width", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 1);
    store.ingest(
      {
        kind: "omp",
        event: {
          type: "message_start",
          messageId: "user-1",
          message: assistantMessage("user", "hello"),
        },
      },
      2,
    );
    store.ingest(
      {
        kind: "omp",
        event: {
          type: "message_start",
          messageId: "developer-1",
          message: assistantMessage("developer", "system note"),
        },
      },
      3,
    );
    store.ingest(
      {
        kind: "omp",
        event: {
          type: "message_start",
          messageId: "assistant-1",
          message: assistantMessage("assistant", "answer"),
        },
      },
      4,
    );
    render(<RuntimeThread store={store} />);

    expect(document.querySelector('[data-message-surface="user-bubble"]')).toBeTruthy();
    expect(document.querySelector('[data-role="user"]')).toBeTruthy();
    expect(document.querySelector('[data-message-surface="system-note"]')).toBeTruthy();
    expect(document.querySelector('[data-message-surface="assistant-text"]')).toBeTruthy();
  });

  test("MessageParts renders the elided-call note from assistant metadata under the answer", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 1);
    store.ingest(
      {
        kind: "omp",
        event: {
          type: "message_start",
          messageId: "assistant-elided",
          message: {
            ...assistantMessage("assistant", "answer"),
            strippedToolCalls: 2,
          } as unknown as OmpMessage,
        },
      } as RpcSessionEvent,
      2,
    );
    render(<RuntimeThread store={store} />);
    expect(screen.getByText("2 tool calls elided — no result on this branch")).toBeTruthy();
  });

  test("MessageParts ignores elided-call metadata on user messages and zero counts", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 1);
    for (const [messageId, message, sequence] of [
      [
        "user-elided",
        { ...assistantMessage("user", "question"), strippedToolCalls: 2 } as unknown as OmpMessage,
        2,
      ],
      [
        "assistant-zero",
        {
          ...assistantMessage("assistant", "answer"),
          strippedToolCalls: 0,
        } as unknown as OmpMessage,
        3,
      ],
    ] as const) {
      store.ingest(
        {
          kind: "omp",
          event: { type: "message_start", messageId, message },
        } as RpcSessionEvent,
        sequence,
      );
    }
    render(<RuntimeThread store={store} />);
    expect(screen.queryByText(/tool call[s]? elided — no result on this branch/)).toBeNull();
  });
  test("does not add a usage-row placeholder when an assistant message has no usage", () => {
    const store = new OmpRuntimeStore({ threadId });
    const noUsage = {
      ...assistantMessage("assistant", "answer without usage"),
      usage: undefined,
    } as unknown as OmpMessage;
    store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 1);
    store.ingest(
      {
        kind: "omp",
        event: {
          type: "message_start",
          messageId: "assistant-no-usage",
          message: noUsage,
        },
      } as RpcSessionEvent,
      2,
    );
    render(<RuntimeThread store={store} />);

    expect(document.querySelector('[data-slot="u1-turn-usage"]')).toBeNull();
  });
  test("does not show partial usage while an assistant message is still running", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 1);
    store.ingest(
      {
        kind: "omp",
        event: {
          type: "message_start",
          messageId: "assistant-running-usage",
          message: assistantMessage("assistant", "streaming answer"),
        },
      } as RpcSessionEvent,
      2,
    );
    render(<RuntimeThread store={store} />);

    expect(document.querySelector('[data-slot="u1-turn-usage"]')).toBeNull();
  });

  test("every message surface lets a long unbroken word wrap inside it", () => {
    const store = new OmpRuntimeStore({ threadId });
    const token = "x".repeat(300);
    store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 1);
    store.ingest(
      {
        kind: "omp",
        event: {
          type: "message_start",
          messageId: "user-1",
          message: assistantMessage("user", token),
        },
      },
      2,
    );
    store.ingest(
      {
        kind: "omp",
        event: {
          type: "message_start",
          messageId: "developer-1",
          message: assistantMessage("developer", token),
        },
      },
      3,
    );
    store.ingest(
      {
        kind: "omp",
        event: {
          type: "message_start",
          messageId: "assistant-1",
          message: assistantMessage("assistant", token),
        },
      },
      4,
    );
    render(<RuntimeThread store={store} />);

    for (const surface of ["user-bubble", "system-note", "assistant-text"]) {
      const element = document.querySelector(`[data-message-surface="${surface}"]`);
      expect(element?.className).toContain("wrap-anywhere");
    }
  });

  test("draws a row's actions after its bubble, inside the message row", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 1);
    store.ingest(
      {
        kind: "omp",
        event: {
          type: "message_start",
          messageId: "user-1",
          message: assistantMessage("user", "hello"),
        },
      },
      2,
    );
    render(<RuntimeThread actions={<button type="button">Probe action</button>} store={store} />);

    const [action] = screen.getAllByRole("button", { name: "Probe action" });
    const row = action?.closest('[data-slot="u1-message-row"]');
    const bubble = row?.querySelector('[data-message-surface="user-bubble"]');
    expect(row?.getAttribute("data-role")).toBe("user");
    expect(action && row?.contains(action)).toBe(true);
    expect(action && bubble?.compareDocumentPosition(action)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  test("keeps the line breaks in a person's own message and nowhere else", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 1);
    store.ingest(
      {
        kind: "omp",
        event: {
          type: "message_start",
          messageId: "user-1",
          message: assistantMessage("user", "line one\nline two"),
        },
      },
      2,
    );
    store.ingest(
      {
        kind: "omp",
        event: {
          type: "message_start",
          messageId: "assistant-1",
          message: assistantMessage("assistant", [{ type: "text", text: "soft one\nsoft two" }]),
        },
      },
      3,
    );
    render(<RuntimeThread store={store} />);

    const userText = document.querySelector('[data-message-surface="user-bubble"] p');
    expect(userText).not.toBeNull();
    // The typed newline becomes a <br>; the newline text after it collapses in the browser.
    expect(userText?.innerHTML).toBe("line one<br>\nline two");
    const answerText = document.querySelector('[data-message-surface="assistant-text"] p');
    expect(answerText?.innerHTML).toBe("soft one\nsoft two");
    expect(answerText?.querySelector("br")).toBeNull();
  });
  test("renders the validated elided-call count under an assistant row, including singular, never for a user row", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.pairEndedMessages(
      [
        {
          type: "message",
          id: "assistant-elided",
          parentId: null,
          timestamp: "2026-10-18T00:00:00.000Z",
          message: {
            ...assistantMessage("assistant", [{ type: "text", text: "Answer" }]),
            strippedToolCalls: 1,
          },
        },
        {
          type: "message",
          id: "user-elided",
          parentId: "assistant-elided",
          timestamp: "2026-10-18T00:00:01.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "User" }],
            timestamp: 1_759_600_000_001,
            strippedToolCalls: 2,
          },
        },
      ],
      "user-elided" as never,
    );
    render(<RuntimeThread store={store} />);
    expect(screen.getByText("1 tool call elided — no result on this branch")).toBeTruthy();
    expect(screen.queryByText("2 tool calls elided — no result on this branch")).toBeNull();
  });
});
