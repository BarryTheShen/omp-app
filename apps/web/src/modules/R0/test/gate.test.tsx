import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ReasoningMessagePartProps,
  TextMessagePartProps,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import type {
  CapabilityMap,
  EntryId,
  Fixture,
  RpcSessionEvent,
  RpcSessionSend,
  ThreadId,
  ToolCallId,
  UiRequestId,
} from "@omp-app/contracts";
import { parseFixture } from "@omp-app/contracts";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test } from "vitest";
import { FixtureSession } from "../../../../../../packages/omp-rpc/src/fixtures";
import type { RpcDuplex } from "../../../../../../packages/omp-rpc/src/session";
import { RpcSession } from "../../../../../../packages/omp-rpc/src/session";
import { QueueController } from "../actions/actions";
import { createOmpBranchingController } from "../branching/branching";
import { SessionHistoryLoader } from "../history/history";
import { createOmpRuntime, useOmpRuntime } from "../runtime/runtime";
import { OmpRuntimeStore, type OmpRuntimeTransport, type RuntimeSnapshot } from "../store/store";

const capabilities: CapabilityMap = {
  "omp.cmd.prompt": { state: "available", via: "rpc" },
  "omp.cmd.bash": { state: "available", via: "rpc" },
  "omp.cmd.abort": { state: "available", via: "rpc" },
  "omp.cmd.abort_bash": { state: "available", via: "rpc" },
  "omp.cmd.get_state": { state: "available", via: "rpc" },
  "omp.cmd.get_entries": { state: "available", via: "rpc" },
  "omp.cmd.get_tree": { state: "available", via: "rpc" },
  "omp.cmd.set_ask_dialog": { state: "available", via: "rpc" },
  "omp.ui": { state: "available", via: "rpc" },
};

type Scenario = "prompt-stream" | "abort" | "ui-round-trip" | "out-of-order";

interface Harness {
  readonly session: RpcSession;
  readonly store: OmpRuntimeStore;
  readonly controller: ReturnType<typeof createOmpRuntime>;
  readonly send: RpcSessionSend;
  readonly threadId: ThreadId;
  readonly feedNotification: (frame: unknown) => void;
  close(): Promise<void>;
}

function fixtureFor(scenario: Scenario): Fixture {
  const text = readFileSync(
    resolve(process.cwd(), "../../packages/omp-rpc/fixtures", `${scenario}.fixture.jsonl`),
    "utf8",
  );
  const parsed = parseFixture(text);
  if (!parsed.ok) throw new Error(`${scenario}: ${parsed.error.message}`);
  return parsed.value;
}

async function openHarness(scenario: Scenario): Promise<Harness> {
  const fixtureSession = new FixtureSession({ fixture: fixtureFor(scenario) });
  const duplex: RpcDuplex = {
    writeLine: (line) => fixtureSession.writeLine(line),
    onChunk: (listener) => fixtureSession.onChunk((chunk) => listener(Uint8Array.from(chunk))),
    onClose: (listener) => fixtureSession.onClose(listener),
    close: () => fixtureSession.close(),
  };
  const session = new RpcSession(duplex);
  const threadId = `${scenario}-thread` as ThreadId;
  const transport: OmpRuntimeTransport = {
    answerExtensionUi: async ({ response }) => {
      await session.answerExtensionUi(response);
      return null;
    },
    answerHostTool: async ({ response }) => {
      await session.answerHostTool(response);
      return null;
    },
    answerHostUri: async ({ response }) => {
      await session.answerHostUri(response);
      return null;
    },
  };
  const store = new OmpRuntimeStore({ threadId, transport });
  let seq = 0;
  const feedNotification = (frame: unknown): void => {
    seq += 1;
    store.ingest({ kind: "notification", frame } as RpcSessionEvent, seq);
  };
  session.onEvent((event) => {
    seq += 1;
    store.ingest(event, seq);
  });
  await session.start();
  const send: RpcSessionSend = (args, options) => session.send(args.command, options) as never;
  const controller = createOmpRuntime({ store, send, capabilities });
  return {
    session,
    store,
    controller,
    send,
    threadId,
    feedNotification,
    close: () => session.close(),
  };
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
  readonly send: RpcSessionSend;
}): ReactElement {
  const { runtime } = useOmpRuntime({ store, send, capabilities });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
    </AssistantRuntimeProvider>
  );
}

describe("R0 W2 recorded fixture runtime gate", () => {
  test("prompt-stream renders real assistant-ui user/text/reasoning/tool DOM and settles", async () => {
    const harness = await openHarness("prompt-stream");
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
      await harness.close();
    }
  });

  test("abort fixture mounts the real thread and leaves partial assistant text visible", async () => {
    const harness = await openHarness("abort");
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
      await harness.close();
    }
  });

  test("out-of-order fixture resolves concurrent commands without cross-correlating results", async () => {
    const harness = await openHarness("out-of-order");
    try {
      const results = await Promise.all([
        harness.session.send({ type: "bash", command: "sleep 1 && echo slow" }),
        harness.session.send({ type: "get_state" }),
      ]);
      expect(results[0]).toMatchObject({ output: "slow\n" });
      expect(results[1]).toMatchObject({ sessionId: expect.any(String) });
    } finally {
      await harness.close();
    }
  });

  test("ui-round-trip routes the extension request through R0.5 answer actions", async () => {
    const harness = await openHarness("ui-round-trip");
    let queue: QueueController | undefined;
    let answerError: unknown;
    const offRequest = harness.session.onRequest((request) => {
      if (request.type !== "extension_ui_request") return;
      harness.feedNotification(request);
      if (request.method === "ask" && queue) {
        void queue
          .answerExtensionUi({
            type: "extension_ui_response",
            id: request.id as UiRequestId,
            answers: [{ id: "db", selectedOptions: ["SQLite"] }],
          })
          .catch((error: unknown) => {
            answerError = error;
          });
      }
    });
    queue = new QueueController({
      store: harness.store,
      send: harness.send,
      capabilities,
    });
    try {
      await harness.send({
        threadId: harness.threadId,
        command: { type: "set_ask_dialog", enabled: true },
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
      offRequest();
      await harness.close();
    }
  });

  test("a seq gap triggers R0.2 refetch and resumes at the remembered stream cursor", async () => {
    const store = new OmpRuntimeStore({ threadId: "gap-thread" as ThreadId });
    store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 5);
    expect(store.getSnapshot().needsRefetch).toBe(true);
    const send: RpcSessionSend = async ({ command }) => {
      if (command.type === "get_state") return { sessionId: "gap-thread" } as never;
      if (command.type === "get_entries") return { entries: [], leafId: null } as never;
      return undefined as never;
    };
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
      store.ingest({ kind: "process", status: "running" } as RpcSessionEvent, 6);
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
      {
        kind: "omp",
        event: {
          type: "message_start",
          messageId: "branch-user",
          message: { role: "user", content: "source", timestamp: 1 },
        },
      } as RpcSessionEvent,
      1,
    );
    store.ingest(
      {
        kind: "omp",
        event: {
          type: "message_end",
          messageId: "branch-user",
          message: { role: "user", content: "source", timestamp: 1 },
        },
      } as RpcSessionEvent,
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
    const send: RpcSessionSend = (async ({ command }) => {
      commands.push(command.type);
      if (command.type === "branch") return { text: "source", cancelled: false };
      if (command.type === "get_state") return { sessionId: "new-thread" };
      return undefined;
    }) as RpcSessionSend;
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
