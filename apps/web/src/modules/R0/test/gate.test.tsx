import type {
  ReasoningMessagePartProps,
  TextMessagePartProps,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import type {
  CapabilityMap,
  ChatSessionEvent,
  ChatSessionRequest,
  EntryId,
  ThreadId,
  ToolCallId,
} from "@omp-app/contracts";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test } from "vitest";
import { ompEvent } from "@/modules/R0/store/session-events";
import { QueueController } from "../actions/actions";
import { createOmpBranchingController } from "../branching/branching";
import {
  playRecording,
  type RecordedSession,
  type SessionRecording,
} from "../fixtures/recorded-session";
import { ABORT, PROMPT_STREAM, UI_ROUND_TRIP } from "../fixtures/recordings";
import { SessionHistoryLoader } from "../history/history";
import { createOmpRuntime, useOmpRuntime } from "../runtime/runtime";
import { OmpRuntimeStore, type RuntimeSnapshot } from "../store/store";

const capabilities: CapabilityMap = {
  "omp.cmd.prompt": { state: "available", via: "omp" },
  "omp.cmd.bash": { state: "available", via: "omp" },
  "omp.cmd.abort": { state: "available", via: "omp" },
  "omp.cmd.abort_bash": { state: "available", via: "omp" },
  "omp.cmd.get_state": { state: "available", via: "omp" },
  "omp.cmd.get_entries": { state: "available", via: "omp" },
  "omp.cmd.get_tree": { state: "available", via: "omp" },
  "omp.cmd.set_ask_dialog": { state: "available", via: "omp" },
  "omp.ui": { state: "available", via: "omp" },
};

interface Harness {
  readonly session: RecordedSession;
  readonly store: OmpRuntimeStore;
  readonly controller: ReturnType<typeof createOmpRuntime>;
  readonly send: ChatSessionRequest;
  readonly threadId: ThreadId;
}

/** The runtime on a recorded chat session: its requests and answers play the recording, its payloads feed the store. */
function openHarness(recording: SessionRecording): Harness {
  const session = playRecording(recording);
  const threadId = `${recording.header.scenario}-thread` as ThreadId;
  const store = new OmpRuntimeStore({ threadId, transport: { answer: session.answer } });
  session.onEvent((event, seq) => store.ingest(event, seq));
  const send = session.request;
  const controller = createOmpRuntime({ store, send, capabilities });
  return { session, store, controller, send, threadId };
}

function waitForSnapshot(
  store: OmpRuntimeStore,
  predicate: (snapshot: RuntimeSnapshot) => boolean,
): Promise<RuntimeSnapshot> {
  const current = store.getSnapshot();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    const unsubscribe = store.subscribe((snapshot) => {
      if (!predicate(snapshot)) return;
      unsubscribe();
      resolve(snapshot);
    });
  });
}

function TextPart({ text }: TextMessagePartProps): ReactElement {
  return <span data-testid="runtime-text">{text}</span>;
}

function ReasoningPart({ text }: ReasoningMessagePartProps): ReactElement {
  return <span data-testid="runtime-reasoning">{text}</span>;
}

function ToolFallback({ toolName, status, result }: ToolCallMessagePartProps): ReactElement {
  const statusText = typeof status === "string" ? status : JSON.stringify(status);
  const resultText = typeof result === "string" ? result : JSON.stringify(result);
  return (
    <span data-testid="runtime-tool">
      {toolName} {statusText} {resultText}
    </span>
  );
}

function UserMessage(): ReactElement {
  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.Parts components={{ Text: TextPart }} />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage(): ReactElement {
  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.Parts
        components={{ Text: TextPart, Reasoning: ReasoningPart, tools: { Fallback: ToolFallback } }}
      />
    </MessagePrimitive.Root>
  );
}

function GateRuntime({
  store,
  send,
}: {
  readonly store: OmpRuntimeStore;
  readonly send: ChatSessionRequest;
}): ReactElement {
  const { runtime } = useOmpRuntime({ store, send, capabilities });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
    </AssistantRuntimeProvider>
  );
}

describe("R0 W2 recorded session runtime gate", () => {
  test("prompt-stream renders real assistant-ui user/text/reasoning/tool DOM and settles", async () => {
    const harness = openHarness(PROMPT_STREAM);
    const ui = render(<GateRuntime store={harness.store} send={harness.send} />);
    try {
      await harness.controller.submitPrompt({ mode: "prompt", text: "run_bash", delivery: "new" });
      const settled = await waitForSnapshot(
        harness.store,
        (snapshot) => snapshot.prompt.promptResult?.status === "completed",
      );
      expect(settled.prompt.promptResult?.status).toBe("completed");
      expect(settled.tools["call_bash" as ToolCallId]?.status).toBe("success");
      expect(screen.getByText("run_bash")).toBeTruthy();
      expect(screen.getByTestId("runtime-reasoning").textContent).toContain("I should run bash.");
      const toolText = screen
        .getAllByTestId("runtime-tool")
        .map((element) => element.textContent ?? "")
        .join(" ");
      expect(toolText).toContain("bash");
      expect(toolText).toContain("fixture-tool");
      expect(screen.getByText(/tool said: fixture-tool/)).toBeTruthy();
    } finally {
      ui.unmount();
      harness.session.close();
    }
  });

  test("abort recording mounts the real thread and leaves partial assistant text visible", async () => {
    const harness = openHarness(ABORT);
    const ui = render(<GateRuntime store={harness.store} send={harness.send} />);
    let cancelled = false;
    const unsubscribe = harness.store.subscribe((snapshot) => {
      if (cancelled || !snapshot.prompt.streaming) return;
      if (
        !Object.values(snapshot.streaming).some((message) => message.message.role === "assistant")
      )
        return;
      cancelled = true;
      void harness.controller.cancel();
    });
    try {
      await harness.controller
        .submitPrompt({ mode: "prompt", text: "abort_slow", delivery: "new" })
        .catch(() => undefined);
      const settled = await waitForSnapshot(
        harness.store,
        (snapshot) => snapshot.prompt.sessionSettled,
      );
      expect(settled.prompt.promptResult?.status).toBe("aborted");
      expect(
        Object.values(settled.messages).some((message) => {
          const raw = message.message;
          return (
            message.interrupted ||
            (typeof raw === "object" &&
              raw !== null &&
              "stopReason" in raw &&
              raw.stopReason === "aborted")
          );
        }),
      ).toBe(true);
      expect(settled.prompt.streaming).toBe(false);
      expect(screen.getByText("abort_slow")).toBeTruthy();
      expect(screen.getByTestId("runtime-reasoning").textContent).toContain("working");
    } finally {
      ui.unmount();
      unsubscribe();
      harness.session.close();
    }
  });

  test("ui-round-trip routes the host's dialog through R0.5 answer actions", async () => {
    const harness = openHarness(UI_ROUND_TRIP);
    const queue = new QueueController({
      store: harness.store,
      send: harness.send,
      capabilities,
    });
    let answerError: unknown;
    // The store has taken the dialog in by now: its listener was added first.
    const offEvent = harness.session.onEvent((event) => {
      if (event.kind !== "host_request" || event.request.method !== "ui.ask") return;
      void queue
        .answerDialog(event.request.id, { answers: [{ id: "db", selectedOptions: ["SQLite"] }] })
        .catch((error: unknown) => {
          answerError = error;
        });
    });
    try {
      await harness.send({
        threadId: harness.threadId,
        method: "set_ask_dialog",
        params: { enabled: true },
      });
      await harness.controller.submitPrompt({ mode: "prompt", text: "ask_user", delivery: "new" });
      const settled = await waitForSnapshot(
        harness.store,
        (snapshot) => snapshot.prompt.promptResult?.status === "completed",
      );
      expect(answerError).toBeUndefined();
      expect(settled.prompt.promptResult?.status).toBe("completed");
      expect(Object.values(settled.tools).some((tool) => tool.result !== undefined)).toBe(true);
    } finally {
      offEvent();
      harness.session.close();
    }
  });

  test("a seq gap triggers R0.2 refetch and resumes at the remembered stream cursor", async () => {
    const store = new OmpRuntimeStore({ threadId: "gap-thread" as ThreadId });
    store.ingest({ kind: "process", status: "ready" } as ChatSessionEvent, 5);
    expect(store.getSnapshot().needsRefetch).toBe(true);
    const send = (async ({ method }: { method: string }) => {
      if (method === "get_state") return { sessionId: "gap-thread" };
      if (method === "get_entries") return { entries: [], leafId: null };
      return {};
    }) as unknown as ChatSessionRequest;
    const loader = new SessionHistoryLoader({
      send,
      threadId: store.getSnapshot().threadId,
      store,
      readWindow: async () => {
        throw new Error("this test has no session file");
      },
    });
    const unsubscribe = loader.watchNeedsRefetch();
    try {
      const recovered = await waitForSnapshot(store, (snapshot) => !snapshot.needsRefetch);
      expect(recovered.lastSeq).toBe(5);
      store.ingest({ kind: "process", status: "running" } as ChatSessionEvent, 6);
      expect(store.getSnapshot().needsRefetch).toBe(false);
    } finally {
      unsubscribe();
      loader.dispose();
    }
  });

  test("branch flow through R0.4 reloads history before admission", async () => {
    const store = new OmpRuntimeStore({ threadId: "source-thread" as ThreadId });
    const entryId = "user-entry" as EntryId;
    store.pairEndedMessages(
      [
        {
          type: "message",
          id: entryId,
          parentId: null,
          timestamp: "2026-10-05T00:00:00.000Z",
          message: { role: "user", content: "source", timestamp: 1 },
        },
      ],
      entryId,
    );
    store.ingest(
      ompEvent({
        type: "message_start",
        messageId: "branch-user",
        message: { role: "user", content: "source", timestamp: 1 },
      }),
      1,
    );
    store.ingest(
      ompEvent({
        type: "message_end",
        messageId: "branch-user",
        message: { role: "user", content: "source", timestamp: 1 },
      }),
      2,
    );
    store.pairEndedMessages(
      [
        {
          type: "message",
          id: entryId,
          parentId: null,
          timestamp: "2026-10-05T00:00:00.000Z",
          message: { role: "user", content: "source", timestamp: 1 },
        },
      ],
      entryId,
    );
    const commands: string[] = [];
    const send = (async ({ method }: { method: string }) => {
      commands.push(method);
      if (method === "branch") return { text: "source", cancelled: false };
      if (method === "get_state") return { sessionId: "new-thread" };
      return undefined;
    }) as unknown as ChatSessionRequest;
    const ui = render(<GateRuntime store={store} send={send} />);
    const controller = createOmpBranchingController({
      store,
      send,
      submitPrompt: async () => {
        commands.push("submitPrompt");
      },
      switchThread: async (threadId) => {
        commands.push(`switch:${threadId}`);
      },
      reloadHistory: async () => {
        commands.push("reloadHistory");
      },
    });
    try {
      expect(screen.getByText("source")).toBeTruthy();
      await controller.editFrom(entryId, { mode: "prompt", text: "edited", delivery: "new" });
      expect(commands).toEqual([
        "branch",
        "get_state",
        "switch:new-thread",
        "reloadHistory",
        "submitPrompt",
      ]);
    } finally {
      ui.unmount();
    }
  });
});
