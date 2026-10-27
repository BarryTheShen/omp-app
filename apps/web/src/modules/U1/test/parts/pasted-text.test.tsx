import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type {
  ChatSessionEvent,
  EntryId,
  OmpMessage,
  RpcSessionSend,
  ThreadId,
} from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ompEvent } from "@/modules/R0/store/session-events";
import { useOmpRuntime } from "../../../R0/runtime";
import { OmpRuntimeStore } from "../../../R0/store";
import { MessageParts } from "../../parts";
import { ThreadShell } from "../../thread";

const threadId = "pasted-text-test" as ThreadId;
const assistantCapabilities = {
  "omp.cmd.prompt": { state: "available" as const, via: "rpc" as const },
};
/** omp's wrapper for a pasted text (omp v18.9.1 `input-controller.ts:216-218`): each tag on a line of its own. */
const block = (text: string) => `<attachment>\n${text}\n</attachment>`;
const LINES = "line one\nline two\nline three";
const CHIP = "Pasted text 1 (3 lines).txt";

const userMessage = (content: string): OmpMessage =>
  ({ role: "user", content, timestamp: 1_759_600_000_000 }) as unknown as OmpMessage;

const testSend: RpcSessionSend = async () => undefined as never;

function RuntimeThread({ store }: { readonly store: OmpRuntimeStore }) {
  const { runtime } = useOmpRuntime({ store, send: testSend, capabilities: assistantCapabilities });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadShell
        slots={{ renderMessage: (message) => <MessageParts message={message} /> }}
        store={store}
      />
    </AssistantRuntimeProvider>
  );
}

function sentStore(content: string): OmpRuntimeStore {
  const store = new OmpRuntimeStore({ threadId });
  store.ingest({ kind: "process", status: "ready" } as ChatSessionEvent, 1);
  store.ingest(
    ompEvent({ type: "message_start", messageId: "user-1", message: userMessage(content) }),
    2,
  );
  return store;
}

function reloadedStore(content: string): OmpRuntimeStore {
  const store = new OmpRuntimeStore({ threadId });
  const entry = {
    type: "message",
    id: "user-1",
    parentId: null,
    timestamp: "2026-10-12T00:00:00.000Z",
    message: userMessage(content),
  };
  store.pairEndedMessages([entry], "user-1" as EntryId);
  return store;
}

beforeEach(() => {
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
});

describe("a pasted block in a person's message", () => {
  test("a sent message shows the typed text and one chip, named as the composer's chip, not the pasted lines", () => {
    render(<RuntimeThread store={sentStore(`Summarize this\n\n${block(LINES)}`)} />);

    expect(screen.getByText("Summarize this")).toBeTruthy();
    expect(screen.getByText(CHIP)).toBeTruthy();
    expect(screen.queryByText(/line two/)).toBeNull();
    expect(document.querySelectorAll('[data-part-type="pasted-text"]')).toHaveLength(1);
  });

  test("a reloaded message shows the same chip", () => {
    render(<RuntimeThread store={reloadedStore(`Summarize this\n\n${block(LINES)}`)} />);

    expect(screen.getByText(CHIP)).toBeTruthy();
    expect(screen.queryByText(/line two/)).toBeNull();
  });

  test("a message that holds the wrapper without its exact layout shows no chip", () => {
    render(<RuntimeThread store={sentStore("Look <attachment>\nno end")} />);

    expect(screen.queryByText(/Pasted text/)).toBeNull();
    expect(document.querySelector('[data-part-type="pasted-text"]')).toBeNull();
  });
});
