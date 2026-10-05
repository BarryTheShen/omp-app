import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { OmpMessage, RpcSessionEvent, RpcSessionSend, ThreadId } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
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
function RuntimeThread({ store }: { readonly store: OmpRuntimeStore }) {
  const { runtime } = useOmpRuntime({
    store,
    send: testSend,
    capabilities: assistantCapabilities,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadShell
        slots={{ renderMessage: (message) => <MessageParts message={message} /> }}
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
});
