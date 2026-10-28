import {
  AssistantRuntimeProvider,
  type AttachmentAdapter,
  fromThreadMessageLike,
  type ThreadMessageLike,
  unstable_convertExternalMessages,
  useAui,
} from "@assistant-ui/react";
import type {
  AppError,
  CapabilityMap,
  ChatSessionEvent,
  ChatSessionRequest,
  MessageKey,
  OmpMessage,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { promptResultEvent } from "../store/session-events";
import type { RuntimeMessage } from "../store/store";
import { OmpRuntimeStore } from "../store/store";
import {
  convertExternalMessage,
  convertMessage,
  createOmpRuntime,
  type RuntimeMessageView,
  retryRecoveryNote,
  stoppedToolCallIds,
  strippedToolCallsCount,
  useOmpRuntime,
} from "./runtime";

const threadId = "runtime-test-thread" as ThreadId;
function AttachmentAdder({ file, onAdded }: { readonly file: File; readonly onAdded: () => void }) {
  const composer = useAui().composer;
  return (
    <button
      type="button"
      onClick={() => {
        void composer.addAttachment(file).then(onAdded);
      }}
    >
      Attach test file
    </button>
  );
}
const baseUsage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
type AssistantMessageContent = Extract<OmpMessage, { role: "assistant" }>["content"];

const capabilities: CapabilityMap = {
  "omp.cmd.prompt": { state: "available", via: "rpc" },
  "omp.cmd.abort_and_prompt": { state: "available", via: "rpc" },
  "omp.cmd.abort": { state: "available", via: "rpc" },
  "omp.cmd.bash": { state: "available", via: "rpc" },
  "omp.cmd.get_state": { state: "available", via: "rpc" },
  "omp.cmd.get_entries": { state: "available", via: "rpc" },
  "omp.cmd.get_tree": { state: "available", via: "rpc" },
};

function assistantMessage(content: AssistantMessageContent): OmpMessage {
  return {
    role: "assistant",
    content: content,
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: baseUsage,
    stopReason: "stop",
    timestamp: 1_759_600_000_000,
  } as OmpMessage;
}
function toolResultMessage(
  toolCallId: string,
  toolName = "bash",
  content: string | readonly { readonly type: "text"; readonly text: string }[] = "done",
): OmpMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    isError: false,
    timestamp: 1_759_600_000_003,
  } as OmpMessage;
}

function customMessage(overrides: Record<string, unknown> = {}): OmpMessage {
  return {
    role: "custom",
    customType: "async-result",
    content: "<system-notice>\nBackground job Reviewer has completed.\n</system-notice>",
    display: true,
    details: { jobs: [{ jobId: "Reviewer", type: "task" }] },
    timestamp: 1_759_600_000_010,
    ...overrides,
  } as OmpMessage;
}

function runtimeMessage(
  message: OmpMessage,
  key = "entry:runtime-test-thread:entry-1",
  status: RuntimeMessage["status"] = "persisted",
): RuntimeMessage {
  return { key: key as MessageKey, message, status };
}

function ompEvent(store: OmpRuntimeStore, event: unknown, seq: number): void {
  store.ingest({ kind: "event", event } as unknown as ChatSessionEvent, seq);
}

function messageParts(message: ThreadMessageLike): readonly Record<string, unknown>[] {
  return (Array.isArray(message.content) ? message.content : []) as readonly Record<
    string,
    unknown
  >[];
}

describe("R0.3 assistant-ui runtime", () => {
  test("converts text, reasoning, images and tool calls with R0 tool state", () => {
    const record = runtimeMessage(
      assistantMessage([
        { type: "text", text: "hello" },
        { type: "thinking", thinking: "reasoning" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        {
          type: "toolCall",
          id: "tool-1",
          name: "bash",
          arguments: { command: "pwd" },
          rawBlock: '{"command":"pwd"}',
        },
      ]),
      undefined,
      "streaming",
    );
    const view: RuntimeMessageView = {
      record,
      toolStates: [
        {
          toolCallId: "tool-1",
          state: {
            toolCallId: "tool-1" as never,
            toolName: "bash",
            args: { command: "pwd" },
            status: "partial",
            partialResult: "working",
            streamProjection: { line: "working" },
            result: undefined,
            isError: false,
          },
        },
      ],
    };

    const converted = convertMessage(view);
    const parts = messageParts(converted);
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "hello", status: { type: "running" } }),
        expect.objectContaining({
          type: "reasoning",
          text: "reasoning",
          status: { type: "running" },
        }),
        expect.objectContaining({ type: "image", image: "data:image/png;base64,aW1hZ2U=" }),
        expect.objectContaining({
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "bash",
          result: "working",
          partialResult: "working",
          streamProjection: { line: "working" },
          status: "partial",
          isPreliminary: true,
        }),
      ]),
    );
  });
  test("joins assistant steps and tool results into one assistant message", () => {
    const views: RuntimeMessageView[] = [
      {
        record: runtimeMessage(
          assistantMessage([
            {
              type: "toolCall",
              id: "tool-join",
              name: "bash",
              arguments: { command: "pwd" },
              rawBlock: '{"command":"pwd"}',
            },
          ]),
          "entry:runtime-test-thread:entry-a",
        ),
        toolStates: [],
        joinedAssistantEntryIds: ["entry-a", "entry-b"],
      },
      {
        record: runtimeMessage(
          assistantMessage([{ type: "text", text: "second assistant step" }]),
          "entry:runtime-test-thread:entry-b",
        ),
        toolStates: [],
        joinedAssistantEntryIds: ["entry-a", "entry-b"],
      },
      {
        record: runtimeMessage(
          toolResultMessage("tool-join", "bash", "wire result"),
          "entry:runtime-test-thread:entry-tool",
        ),
        toolStates: [
          {
            toolCallId: "tool-join",
            state: {
              toolCallId: "tool-join" as never,
              toolName: "bash",
              args: { command: "pwd" },
              status: "success",
              partialResult: undefined,
              streamProjection: { lines: ["wire result"] },
              result: "state result",
              isError: false,
            },
          },
        ],
        joinedAssistantEntryIds: ["entry-a", "entry-b"],
        toolResultMatched: true,
      },
    ];
    const joined = unstable_convertExternalMessages(views, convertExternalMessage, false, {});
    expect(joined).toHaveLength(1);
    const message = joined[0];
    if (!message) throw new Error("expected a joined message");
    expect(message.metadata?.custom?.ompEntryIds).toEqual(["entry-a", "entry-b"]);
    const parts = messageParts(message);
    expect(parts.filter((part) => part.type === "tool-call")).toHaveLength(1);
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-call",
          toolCallId: "tool-join",
          result: "state result",
          artifact: { lines: ["wire result"] },
        }),
        expect.objectContaining({ type: "text", text: "second assistant step" }),
      ]),
    );
    expect(() =>
      fromThreadMessageLike(message, "joined", { type: "complete", reason: "unknown" }),
    ).not.toThrow();
  });

  test("a message a todo reminder follows closes its row, so the answer after it is a row of its own", () => {
    const answer = (closesRow: boolean): RuntimeMessageView[] => [
      {
        record: runtimeMessage(
          assistantMessage([{ type: "text", text: "tool said" }]),
          "entry:runtime-test-thread:entry-a",
        ),
        toolStates: [],
        joinedAssistantEntryIds: ["entry-a", "entry-b"],
        closesRow,
      },
      {
        record: runtimeMessage(
          assistantMessage([{ type: "text", text: "pong" }]),
          "entry:runtime-test-thread:entry-b",
        ),
        toolStates: [],
        joinedAssistantEntryIds: ["entry-a", "entry-b"],
      },
    ];
    const joined = unstable_convertExternalMessages(
      answer(false),
      convertExternalMessage,
      false,
      {},
    );
    expect(joined.map((row) => row.id)).toEqual(["entry:runtime-test-thread:entry-a"]);
    const split = unstable_convertExternalMessages(answer(true), convertExternalMessage, false, {});
    expect(split.map((row) => row.id)).toEqual([
      "entry:runtime-test-thread:entry-a",
      "entry:runtime-test-thread:entry-b",
    ]);
  });

  test("a reminder after a tool result closes the answer that called the tool, so the answer after the reminder starts a row", () => {
    const turn = (closesCalling: boolean): RuntimeMessageView[] => [
      {
        record: runtimeMessage(
          assistantMessage([{ type: "text", text: "calling the tool" }]),
          "entry:runtime-test-thread:entry-call",
        ),
        toolStates: [],
        joinedAssistantEntryIds: [],
        closesRow: closesCalling,
      },
      {
        record: runtimeMessage(
          toolResultMessage("call-1"),
          "entry:runtime-test-thread:entry-result",
        ),
        toolStates: [],
        joinedAssistantEntryIds: [],
        toolResultMatched: true,
      },
      {
        record: runtimeMessage(
          assistantMessage([{ type: "text", text: "pong" }]),
          "entry:runtime-test-thread:entry-answer",
        ),
        toolStates: [],
        joinedAssistantEntryIds: [],
      },
    ];
    const joined = unstable_convertExternalMessages(turn(false), convertExternalMessage, false, {});
    expect(joined.map((row) => row.id)).toEqual(["entry:runtime-test-thread:entry-call"]);
    const split = unstable_convertExternalMessages(turn(true), convertExternalMessage, false, {});
    expect(split.map((row) => row.id)).toEqual([
      "entry:runtime-test-thread:entry-call",
      "entry:runtime-test-thread:entry-answer",
    ]);
  });

  test("keeps an orphaned tool result visible instead of dropping it", () => {
    const orphan: RuntimeMessageView = {
      record: runtimeMessage(toolResultMessage("orphan-tool"), "entry:runtime-test-thread:orphan"),
      toolStates: [],
      joinedAssistantEntryIds: [],
      toolResultMatched: false,
    };
    const joined = unstable_convertExternalMessages([orphan], convertExternalMessage, false, {});
    expect(joined).toHaveLength(1);
    const message = joined[0];
    if (!message) throw new Error("expected an orphan message");
    expect(messageParts(message)).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolCallId: "orphan-tool",
        toolName: "bash",
        // A history tool result has the same `{ content, details }` shape as a live one.
        result: { content: [{ type: "text", text: "done" }] },
      }),
    ]);
    expect(() =>
      fromThreadMessageLike(message, "orphan", { type: "complete", reason: "unknown" }),
    ).not.toThrow();
  });

  test("memoizes unchanged message conversion across an unrelated store update", () => {
    const store = new OmpRuntimeStore({ threadId });
    ompEvent(
      store,
      {
        type: "message_start",
        messageId: "m-1",
        message: assistantMessage([{ type: "text", text: "hello" }]),
      },
      1,
    );
    const send: ChatSessionRequest = async () => undefined as never;
    const controller = createOmpRuntime({ store, send, capabilities });
    const firstAdapter = controller.createAdapter();
    const firstView = (firstAdapter.messages ?? [])[0];
    if (!firstView) throw new Error("expected a message view");
    const firstConverted = firstAdapter.convertMessage(firstView, 0);

    store.ingest({ kind: "process", status: "ready" } as ChatSessionEvent, 2);
    const secondAdapter = controller.createAdapter();
    const secondView = (secondAdapter.messages ?? [])[0];
    if (!secondView) throw new Error("expected a message view");
    expect(secondView).toBe(firstView);
    expect(secondAdapter.convertMessage(secondView, 0)).toBe(firstConverted);
  });

  test("a `!` command is a row while it runs, and stays a row with omp's answer once it ends", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.ingest(
      {
        kind: "shell",
        method: "bash",
        input: "echo hi",
        status: "running",
        startedAt: 1,
      } as ChatSessionEvent,
      1,
    );
    const send: ChatSessionRequest = async () => undefined as never;
    const controller = createOmpRuntime({ store, send, capabilities });
    const runningView = (controller.createAdapter().messages ?? [])[0];
    if (!runningView) throw new Error("expected the command's row");
    expect(runningView.commandState).toBe("running");
    expect(runningView.record.status).toBe("streaming");
    expect(
      controller.createAdapter().convertMessage(runningView, 0).metadata?.custom,
    ).toMatchObject({ ompCommandState: "running" });

    store.ingest(
      {
        kind: "shell",
        method: "bash",
        input: "echo hi",
        status: "ended",
        startedAt: 1,
        result: { output: "hi\n", exitCode: 0, cancelled: false, truncated: false },
      } as ChatSessionEvent,
      2,
    );
    const endedView = (controller.createAdapter().messages ?? [])[0];
    if (!endedView) throw new Error("expected the command's row");
    expect(endedView.commandState).toBeUndefined();
    expect(endedView.record.status).toBe("ended");
    const endedCustom = controller.createAdapter().convertMessage(endedView, 0).metadata?.custom;
    expect(endedCustom).toMatchObject({ ompExecution: { output: "hi\n", exitCode: 0 } });
    expect(endedCustom).not.toHaveProperty("ompCommandState");
  });

  test("submits through the typed prompt port and resolves at admission", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    let admit!: (value: unknown) => void;
    const send: ChatSessionRequest = async (args) => {
      calls.push({ method: args.method, params: args.params });
      return new Promise((resolve) => {
        admit = resolve;
      }) as never;
    };
    const controller = createOmpRuntime({ store, send, capabilities });
    const submission = controller.submitPrompt({
      mode: "prompt",
      text: "hello",
      delivery: "new",
    });
    await Promise.resolve();
    expect(calls).toEqual([{ method: "prompt", params: { text: "hello" } }]);
    let settled = false;
    void submission.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    admit({ resultFollows: true });
    await expect(submission).resolves.toBeUndefined();
  });

  test("preserves a pre-admission AppFailure and does not swallow its code", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const failure = new AppFailure({
      code: "permission",
      message: "Prompt was refused",
      retryable: false,
    } satisfies AppError);
    const send: ChatSessionRequest = async () => {
      throw failure;
    };
    const controller = createOmpRuntime({ store, send, capabilities });
    await expect(
      controller.submitPrompt({ mode: "prompt", text: "keep this", delivery: "new" }),
    ).rejects.toBe(failure);
  });

  test("a prompt marks its chat sent while it is sent, and a refused prompt unmarks it", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const seen: boolean[] = [];
    const send: ChatSessionRequest = async () => {
      seen.push(store.getSnapshot().prompt.sent);
      throw new AppFailure({
        code: "permission",
        message: "Prompt was refused",
        retryable: false,
      } satisfies AppError);
    };
    const controller = createOmpRuntime({ store, send, capabilities });
    await expect(
      controller.submitPrompt({ mode: "prompt", text: "hello", delivery: "new" }),
    ).rejects.toBeInstanceOf(AppFailure);
    expect(seen).toEqual([true]);
    expect(store.getSnapshot().prompt.sent).toBe(false);
  });

  test("a slash command does not mark its chat sent, since omp answers it without a message", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const send: ChatSessionRequest = (async () => ({ resultFollows: false })) as never;
    const controller = createOmpRuntime({ store, send, capabilities });
    await controller.submitPrompt({ mode: "prompt", text: "/usage", delivery: "new" });
    expect(store.getSnapshot().prompt.sent).toBe(false);
  });

  test("gates Python without sending a replacement prompt", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const commands: unknown[] = [];
    const send: ChatSessionRequest = async ({ method, params }) => {
      commands.push({ method, params });
      return undefined as never;
    };
    const controller = createOmpRuntime({ store, send, capabilities });
    await expect(
      controller.submitPrompt({ mode: "python", text: "print(1)", delivery: "new" }),
    ).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "upstream.python-mode" },
    });
    expect(commands).toEqual([]);
  });

  test("a plain new prompt shows its row before its request goes out, and a refused one takes it away", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const rowsAtSend: number[] = [];
    const send: ChatSessionRequest = async () => {
      rowsAtSend.push(store.getSnapshot().pendingPrompts.length);
      throw new AppFailure({
        code: "permission",
        message: "Prompt was refused",
        retryable: false,
      } satisfies AppError);
    };
    const controller = createOmpRuntime({ store, send, capabilities });
    await expect(
      controller.submitPrompt({ mode: "prompt", text: "hello", delivery: "new" }),
    ).rejects.toBeInstanceOf(AppFailure);
    expect(rowsAtSend).toEqual([1]);
    expect(store.getSnapshot()).toMatchObject({
      messageOrder: [],
      pendingPrompts: [],
      prompt: { sent: false },
    });
  });

  test("the row of a plain new prompt is a user row with its text, and omp's echo takes its place", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const admitted = Promise.withResolvers<void>();
    const send: ChatSessionRequest = async () => admitted.promise as never;
    const controller = createOmpRuntime({ store, send, capabilities });
    const submission = controller.submitPrompt({ mode: "prompt", text: "hello", delivery: "new" });
    const [row] = controller.messages();
    expect(controller.messages()).toHaveLength(1);
    expect(row?.record.status).toBe("pending");
    expect(convertMessage(row as RuntimeMessageView)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
    ompEvent(
      store,
      {
        type: "message_start",
        messageId: "u1",
        message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
      },
      1,
    );
    const [echoed] = controller.messages();
    expect(controller.messages()).toHaveLength(1);
    expect(convertMessage(echoed as RuntimeMessageView).id).toBe(
      convertMessage(row as RuntimeMessageView).id,
    );
    admitted.resolve();
    await expect(submission).resolves.toBeUndefined();
  });

  test("a waiting row is drawn after the chat's messages, and its echo keeps its id in that place", () => {
    const store = new OmpRuntimeStore({ threadId });
    const earlier = assistantMessage([{ type: "text", text: "earlier answer" }]);
    store.pairEndedMessages([
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: new Date(1_759_600_000_000).toISOString(),
        message: earlier,
      },
    ]);
    const answered = Promise.withResolvers<void>();
    const send: ChatSessionRequest = async () => answered.promise as never;
    const controller = createOmpRuntime({ store, send, capabilities });
    void controller.submitPrompt({ mode: "prompt", text: "next question", delivery: "new" });
    const waiting = store.getSnapshot().pendingPrompts[0]?.key;
    expect(store.getSnapshot().messageOrder).toEqual(["entry:runtime-test-thread:a1"]);
    expect(controller.messages().map((view) => view.record.key)).toEqual([
      "entry:runtime-test-thread:a1",
      waiting,
    ]);
    ompEvent(
      store,
      {
        type: "message_start",
        messageId: "u1",
        message: { role: "user", content: [{ type: "text", text: "next question" }], timestamp: 3 },
      },
      1,
    );
    expect(controller.messages().map((view) => convertMessage(view).id)).toEqual([
      "entry:runtime-test-thread:a1",
      waiting,
    ]);
    answered.resolve();
  });

  test("steer, follow-up, bash, python and slash commands add no row of their own", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const bashCapabilities: CapabilityMap = {
      ...capabilities,
      "omp.cmd.bash": { state: "available", via: "rpc" },
    };
    const send: ChatSessionRequest = async () => undefined as never;
    const controller = createOmpRuntime({ store, send, capabilities: bashCapabilities });
    await controller.submitPrompt({
      mode: "prompt",
      text: "also check the tests",
      delivery: "steer",
    });
    await controller.submitPrompt({ mode: "prompt", text: "and then this", delivery: "followUp" });
    await controller.submitPrompt({ mode: "bash", text: "printf hi", delivery: "new" });
    await expect(
      controller.submitPrompt({ mode: "python", text: "print(1)", delivery: "new" }),
    ).rejects.toBeInstanceOf(AppFailure);
    await controller.submitPrompt({ mode: "prompt", text: "/usage", delivery: "new" });
    expect(store.getSnapshot().messageOrder).toEqual([]);
    expect(store.getSnapshot().pendingPrompts).toEqual([]);
  });

  test("gates a bash command that keeps its output out of the model, without sending it", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const commands: unknown[] = [];
    const send: ChatSessionRequest = async ({ method, params }) => {
      commands.push({ method, params });
      return undefined as never;
    };
    const controller = createOmpRuntime({ store, send, capabilities });
    await expect(
      controller.submitPrompt({
        mode: "bash",
        text: "printf hello",
        delivery: "new",
        excludeFromContext: true,
      }),
    ).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "upstream.bash-exclude-from-context" },
    });
    expect(commands).toEqual([]);
  });
  test("maps cancel to omp abort and hides unavailable actions", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const commands: unknown[] = [];

    const send: ChatSessionRequest = async ({ method, params }) => {
      commands.push({ method, params });
      return undefined as never;
    };
    const available = createOmpRuntime({ store, send, capabilities }).createAdapter();
    expect(available.onCancel).toBeTypeOf("function");
    await available.onCancel?.();
    expect(commands).toEqual([{ method: "abort", params: {} }]);

    const unavailable = createOmpRuntime({ store, send, capabilities: {} }).createAdapter();
    expect(unavailable.onCancel).toBeUndefined();
    expect(unavailable.onRefetchThread).toBeUndefined();
    expect(unavailable.unstable_enableToolInvocations).toBe(false);
  });

  test("Stop with queued input withdraws it with abort_and_restore_queue and hands it back", async () => {
    const store = new OmpRuntimeStore({ threadId });
    store.ingest(
      {
        kind: "event",
        event: { type: "queue_update", steering: ["steer first"], followUp: ["follow second"] },
      } as Parameters<OmpRuntimeStore["ingest"]>[0],
      1,
    );
    const withdrawn = {
      steering: [{ text: "steer first" }],
      followUp: [{ text: "follow second" }],
    };
    const commands: unknown[] = [];
    const handedBack: unknown[] = [];
    const send: ChatSessionRequest = async ({ method, params }) => {
      commands.push({ method, params });
      return withdrawn as never;
    };
    const controller = createOmpRuntime({
      store,
      send,
      capabilities: {
        ...capabilities,
        "omp.cmd.abort_and_restore_queue": { state: "available", via: "rpc" },
      },
      onQueueRestored: (restored) => handedBack.push(restored),
    });
    await controller.cancel();
    expect(commands).toEqual([{ method: "abort_and_restore_queue", params: {} }]);
    expect(handedBack).toEqual([{ threadId, restored: withdrawn }]);
  });

  test("Stop with nothing queued still sends plain abort and hands nothing back", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const commands: unknown[] = [];
    const handedBack: unknown[] = [];
    const send: ChatSessionRequest = async ({ method, params }) => {
      commands.push({ method, params });
      return undefined as never;
    };
    const controller = createOmpRuntime({
      store,
      send,
      capabilities: {
        ...capabilities,
        "omp.cmd.abort_and_restore_queue": { state: "available", via: "rpc" },
      },
      onQueueRestored: (restored) => handedBack.push(restored),
    });
    await controller.cancel();
    expect(commands).toEqual([{ method: "abort", params: {} }]);
    expect(handedBack).toEqual([]);
  });

  test("offers edit and regenerate only while omp can branch", () => {
    const store = new OmpRuntimeStore({ threadId });
    const send: ChatSessionRequest = async () => undefined as never;
    const onEdit = async () => undefined;
    const onReload = async () => undefined;
    const branchable = {
      ...capabilities,
      "omp.cmd.branch": { state: "available" as const, via: "rpc" as const },
    };

    const offered = createOmpRuntime({
      store,
      send,
      capabilities: branchable,
      onEdit,
      onReload,
    }).createAdapter();
    expect(offered.onEdit).toBe(onEdit);
    expect(offered.onReload).toBe(onReload);

    const withheld = createOmpRuntime({
      store,
      send,
      capabilities,
      onEdit,
      onReload,
    }).createAdapter();
    expect(withheld.onEdit).toBeUndefined();
    expect(withheld.onReload).toBeUndefined();
  });

  test("rejects slash commands while streaming instead of steering their text", async () => {
    const store = new OmpRuntimeStore({ threadId });
    ompEvent(store, { type: "agent_start" }, 1);
    const commands: unknown[] = [];
    const send: ChatSessionRequest = async ({ method, params }) => {
      commands.push({ method, params });
      return undefined as never;
    };
    const controller = createOmpRuntime({ store, send, capabilities });
    await expect(
      controller.submitPrompt({ mode: "prompt", text: "  /tree", delivery: "steer" }),
    ).rejects.toMatchObject({
      appError: {
        code: "invalid_args",
        message: "Slash commands cannot be sent while a prompt is streaming",
      },
    });
    expect(commands).toEqual([]);
  });

  test("never interrupts a running turn implicitly: delivery new while streaming is rejected", async () => {
    const store = new OmpRuntimeStore({ threadId });
    ompEvent(store, { type: "agent_start" }, 1);
    const commands: unknown[] = [];
    const send: ChatSessionRequest = async ({ method, params }) => {
      commands.push({ method, params });
      return undefined as never;
    };
    const controller = createOmpRuntime({ store, send, capabilities });
    await expect(
      controller.submitPrompt({ mode: "prompt", text: "also check the tests", delivery: "new" }),
    ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
    expect(commands).toEqual([]);
    await controller.submitPrompt({
      mode: "prompt",
      text: "also check the tests",
      delivery: "steer",
    });
    expect(commands).toEqual([
      { method: "prompt", params: { text: "also check the tests", streamingBehavior: "steer" } },
    ]);
  });

  test("uses abort_bash for cancellation while a bash command is active", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const bashCapabilities: CapabilityMap = {
      ...capabilities,
      "omp.cmd.abort_bash": { state: "available", via: "rpc" },
    };
    const commands: unknown[] = [];
    let finish!: (value: unknown) => void;
    const send: ChatSessionRequest = async ({ method, params }) => {
      commands.push({ method, params });
      if (method === "bash") {
        return new Promise((resolve) => {
          finish = resolve;
        }) as never;
      }
      return undefined as never;
    };
    const controller = createOmpRuntime({ store, send, capabilities: bashCapabilities });
    const bash = controller.submitPrompt({ mode: "bash", text: "printf hello", delivery: "new" });
    await Promise.resolve();
    await controller.cancel();
    expect(commands).toEqual([
      { method: "bash", params: { command: "printf hello" } },
      { method: "abort_bash", params: {} },
    ]);
    finish(undefined);
    await expect(bash).resolves.toBeUndefined();
  });

  test("uses prompt_result for running state without conflating session_settled", () => {
    const store = new OmpRuntimeStore({ threadId });
    const send: ChatSessionRequest = async () => undefined as never;
    const controller = createOmpRuntime({ store, send, capabilities });
    ompEvent(store, { type: "agent_start" }, 1);
    expect(controller.createAdapter().isRunning).toBe(true);
    store.ingest(
      promptResultEvent({
        type: "prompt_result",
        requestId: "p1",
        agentInvoked: true,
        status: "completed",
        sessionSettled: false,
      }),
      2,
    );
    expect(controller.createAdapter().isRunning).toBe(false);
    expect(store.getSnapshot().prompt.sessionSettled).toBe(false);
    store.ingest({ kind: "event", event: { type: "session_settled" } } as ChatSessionEvent, 3);
    expect(store.getSnapshot().prompt.sessionSettled).toBe(true);
  });

  test("installs the external-store runtime through the React hook", () => {
    const store = new OmpRuntimeStore({ threadId });
    const send: ChatSessionRequest = async () => undefined as never;
    const result = renderHook(() => useOmpRuntime({ store, send, capabilities }));
    expect(result.result.current.runtime).toBeDefined();
    expect(result.result.current.controller).toBeInstanceOf(Object);
    result.unmount();
  });
  test("installs the supplied attachment adapter in the external composer runtime", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const send: ChatSessionRequest = async () => undefined as never;
    const addedFiles: string[] = [];
    const attachments: AttachmentAdapter = {
      accept: "text/plain",
      add: async ({ file }) => {
        addedFiles.push(file.name);
        return {
          id: "runtime-test-attachment",
          type: "file",
          name: file.name,
          contentType: file.type,
          file,
          status: { type: "requires-action", reason: "composer-send" },
        };
      },
      send: async (attachment) => ({
        ...attachment,
        status: { type: "complete" },
        content: [],
      }),
      remove: async () => undefined,
    };
    const result = renderHook(() => useOmpRuntime({ store, send, capabilities, attachments }));
    const file = new File(["draft"], "notes.txt", { type: "text/plain" });
    const added = Promise.withResolvers<void>();
    const view = render(
      <AssistantRuntimeProvider runtime={result.result.current.runtime}>
        <AttachmentAdder file={file} onAdded={() => added.resolve()} />
      </AssistantRuntimeProvider>,
    );

    fireEvent.click(view.getByRole("button", { name: "Attach test file" }));
    await act(async () => {
      await added.promise;
    });

    expect(addedFiles).toEqual(["notes.txt"]);
    view.unmount();
    result.unmount();
  });

  test("every role converts into a message assistant-ui accepts (status only on assistant messages)", () => {
    const records = [
      { role: "user", content: "hello", timestamp: 1 },
      { role: "user", content: [{ type: "text", text: "with parts" }], timestamp: 2 },
      { role: "developer", content: "system note", timestamp: 3 },
      assistantMessage([{ type: "text", text: "answer" }]),
    ];
    for (const [index, message] of records.entries()) {
      const view: RuntimeMessageView = {
        record: {
          key: `entry:runtime-test-thread:m${index}` as MessageKey,
          message: message as unknown as OmpMessage,
          status: "persisted",
        } as RuntimeMessage,
        toolStates: [],
      };
      const converted = convertMessage(view, index);
      // assistant-ui's own conversion throws on a status outside assistant messages.
      expect(() =>
        fromThreadMessageLike(converted, `m${index}`, { type: "complete", reason: "unknown" }),
      ).not.toThrow();
    }
  });

  test("renders a visible fallback part for a malformed message", () => {
    const converted = convertMessage({
      key: "entry:runtime-test-thread:bad" as MessageKey,
      message: { role: "not-a-message", content: null } as unknown as OmpMessage,
      status: "persisted",
    });
    const parts = messageParts(converted);
    const text = parts.find((part) => part.type === "text")?.text;
    const result = render(<div>{typeof text === "string" ? text : ""}</div>);
    expect(result.getByText("Unable to render this omp message.")).toBeTruthy();
  });

  test("converts omp's custom messages into note messages that assistant-ui accepts", () => {
    for (const message of [customMessage(), customMessage({ role: "hookMessage" })]) {
      const converted = convertMessage(
        runtimeMessage(message, "entry:runtime-test-thread:note") as RuntimeMessageView["record"],
      );
      expect(converted.role).toBe("system");
      expect(converted.metadata?.custom).toMatchObject({
        ompRole: message.role,
        ompCustomType: "async-result",
        ompCustomDetails: { jobs: [{ jobId: "Reviewer", type: "task" }] },
      });
      expect(messageParts(converted)).toEqual([
        expect.objectContaining({
          type: "text",
          text: "<system-notice>\nBackground job Reviewer has completed.\n</system-notice>",
        }),
      ]);
      expect(() =>
        fromThreadMessageLike(converted, "note", { type: "complete", reason: "unknown" }),
      ).not.toThrow();
    }
  });

  test("converts omp's branch summary into a system row that carries the summary for the divider", () => {
    const message = {
      role: "branchSummary",
      summary: "## Goal\n\n<files>\n# src/\nparser.ts (Read)\n</files>",
      fromId: "entry-left",
      timestamp: 1_759_600_000_000,
    } as unknown as OmpMessage;
    const converted = convertMessage(
      runtimeMessage(message, "entry:runtime-test-thread:summary") as RuntimeMessageView["record"],
    );
    expect(converted.role).toBe("system");
    expect(converted.metadata?.custom).toMatchObject({
      ompRole: "branchSummary",
      ompBranchSummary: message,
    });
    expect(() =>
      fromThreadMessageLike(converted, "summary", { type: "complete", reason: "unknown" }),
    ).not.toThrow();
  });

  test("converts omp's compaction summary into a system row with its counts for the divider", () => {
    const message = {
      role: "compactionSummary",
      summary: "## Kept context\n\n- Keep the current goal",
      tokensBefore: 120_000,
      tokensAfter: 28_000,
      timestamp: 1_759_600_000_000,
      method: "remote",
    } as unknown as OmpMessage;
    const converted = convertMessage(
      runtimeMessage(
        message,
        "entry:runtime-test-thread:compaction",
      ) as RuntimeMessageView["record"],
    );
    expect(converted.role).toBe("system");
    expect(converted.metadata?.custom).toMatchObject({
      ompRole: "compactionSummary",
      ompCompactionSummary: message,
    });
    expect(() =>
      fromThreadMessageLike(converted, "compaction", { type: "complete", reason: "unknown" }),
    ).not.toThrow();
  });

  test("a turn carries the usage of the turn before it, so a cold cache is measured from the warm one", () => {
    const store = new OmpRuntimeStore({ threadId });
    const warm = { ...baseUsage, input: 300, cacheRead: 4_000, totalTokens: 4_300 };
    const cold = { ...baseUsage, input: 300, cacheRead: 0, cacheWrite: 800, totalTokens: 1_100 };
    const turns = [
      { role: "user", content: [{ type: "text", text: "First question." }], timestamp: 1 },
      { ...assistantMessage([{ type: "text", text: "First answer." }]), usage: warm, timestamp: 2 },
      { role: "user", content: [{ type: "text", text: "Second question." }], timestamp: 3 },
      {
        ...assistantMessage([{ type: "text", text: "Second answer." }]),
        usage: cold,
        timestamp: 4,
        duration: 1_200,
        ttft: 300,
      },
    ] as unknown as OmpMessage[];
    turns.forEach((message, index) => {
      ompEvent(store, { type: "message_start", messageId: `m${index}`, message }, index * 2 + 1);
      ompEvent(store, { type: "message_end", messageId: `m${index}`, message }, index * 2 + 2);
    });
    ompEvent(store, { type: "agent_end" }, 9);
    const views = createOmpRuntime({
      store,
      send: (() => Promise.resolve()) as unknown as ChatSessionRequest,
    }).messages();
    expect(views.map((view) => view.record.message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    // The first answer has no turn before it; the second is measured from the first one's usage.
    expect(views[1]?.previousAssistantUsage).toBeNull();
    expect(views[3]?.previousAssistantUsage).toEqual(warm);
    const second = views[3];
    if (!second) throw new Error("expected the second answer");
    expect(convertMessage(second).metadata?.custom).toMatchObject({
      ompUsage: cold,
      ompTurnUsage: { input: 300, output: 1, cacheRead: 0, cacheWrite: 800 },
      ompTurnDurationMs: 1_200,
      ompTurnTtftMs: 300,
      ompPreviousUsage: warm,
    });
  });
  test("sums usage and durations for all assistant requests joined with tool results", () => {
    const store = new OmpRuntimeStore({ threadId });
    ompEvent(store, { type: "agent_start" }, 1);
    const usageOne = { ...baseUsage, input: 10, output: 5, cacheRead: 2, cacheWrite: 3 };
    const usageTwo = { ...baseUsage, input: 20, output: 6, cacheRead: 4, cacheWrite: 1 };
    const usageThree = { ...baseUsage, input: 30, output: 7, cacheRead: 5, cacheWrite: 2 };
    const requests = [
      { role: "user", content: [{ type: "text", text: "Run three tools." }], timestamp: 1 },
      {
        ...assistantMessage([{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }]),
        usage: usageOne,
        stopReason: "toolUse",
        duration: 120,
        ttft: 45,
        timestamp: 2,
      },
      toolResultMessage("call-1"),
      {
        ...assistantMessage([{ type: "toolCall", id: "call-2", name: "bash", arguments: {} }]),
        usage: usageTwo,
        stopReason: "toolUse",
        duration: 180,
        ttft: 30,
        timestamp: 3,
      },
      toolResultMessage("call-2"),
      {
        ...assistantMessage([{ type: "text", text: "Finished." }]),
        usage: usageThree,
        duration: 220,
        ttft: 25,
        timestamp: 4,
      },
    ] as unknown as OmpMessage[];
    requests.forEach((message, index) => {
      ompEvent(
        store,
        { type: "message_start", messageId: `turn-${index}`, message },
        index * 2 + 2,
      );
      ompEvent(store, { type: "message_end", messageId: `turn-${index}`, message }, index * 2 + 3);
    });
    const runningViews = createOmpRuntime({
      store,
      send: (() => Promise.resolve()) as unknown as ChatSessionRequest,
    }).messages();
    expect(
      runningViews
        .filter((view) => view.record.message.role === "assistant")
        .every((view) => view.ompTurnUsage === undefined),
    ).toBe(true);
    ompEvent(store, { type: "agent_end" }, requests.length * 2 + 2);

    const views = createOmpRuntime({
      store,
      send: (() => Promise.resolve()) as unknown as ChatSessionRequest,
    }).messages();
    const assistantViews = views.filter((view) => view.record.message.role === "assistant");
    expect(assistantViews).toHaveLength(3);
    const totals = { input: 60, output: 18, cacheRead: 11, cacheWrite: 6 };
    for (const view of assistantViews) {
      expect(view.ompTurnUsage).toEqual(totals);
      expect(view.ompTurnDurationMs).toBe(520);
      expect(view.ompTurnTtftMs).toBe(45);
    }

    const joined = unstable_convertExternalMessages(
      views.slice(1),
      convertExternalMessage,
      false,
      {},
    );
    expect(joined).toHaveLength(1);
    const message = joined[0];
    if (!message) throw new Error("expected a joined assistant turn");
    expect(message.metadata?.custom).toMatchObject({
      ompTurnUsage: totals,
      ompTurnDurationMs: 520,
      ompTurnTtftMs: 45,
    });
  });

  test("shows a user's bash run as a system row that keeps omp's record for U1's card", () => {
    const run = {
      role: "bashExecution",
      command: "ls /missing",
      output: "ls: cannot access '/missing'\n",
      exitCode: 2,
      cancelled: false,
      truncated: false,
      timestamp: 1,
    };
    const record = runtimeMessage(
      run as unknown as Parameters<typeof runtimeMessage>[0],
      "entry:runtime-test-thread:bash",
    );
    const converted = convertMessage(record as RuntimeMessageView["record"]);
    expect(converted.role).toBe("system");
    expect(converted.metadata?.custom).toMatchObject({
      ompRole: "bashExecution",
      ompExecution: run,
    });
    expect(() =>
      fromThreadMessageLike(converted, "bash", { type: "complete", reason: "unknown" }),
    ).not.toThrow();
  });

  test("shows omp's file mention as a system row that keeps its file list, not the fallback (issue 1266)", () => {
    const message = {
      role: "fileMention",
      files: [{ path: "notes.txt", content: "first\nsecond\n", lineCount: 2 }],
      timestamp: 1_759_600_000_000,
    } as unknown as OmpMessage;
    const converted = convertMessage(
      runtimeMessage(message, "entry:runtime-test-thread:files") as RuntimeMessageView["record"],
    );
    expect(converted.role).toBe("system");
    expect(converted.metadata?.custom).toMatchObject({
      ompRole: "fileMention",
      ompFileMention: message,
    });
    expect(converted.metadata?.custom).not.toHaveProperty("ompFallback");
    expect(() =>
      fromThreadMessageLike(converted, "files", { type: "complete", reason: "unknown" }),
    ).not.toThrow();
  });

  test("a row keeps the id of its streamed copy, and its metadata carries the store key (issue 1047)", () => {
    const message = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1_759_600_000_000,
    } as unknown as OmpMessage;
    const record: RuntimeMessage = {
      ...runtimeMessage(message, "entry:runtime-test-thread:entry-1"),
      rowKey: "stream:runtime-test-thread:0:m1" as MessageKey,
    };
    const converted = convertMessage(record);
    expect(converted.id).toBe("stream:runtime-test-thread:0:m1");
    expect(converted.metadata?.custom).toMatchObject({
      ompMessageKey: "entry:runtime-test-thread:entry-1",
    });
  });

  test("a custom message marked display:false is saved but never a row, and does not split a turn", () => {
    const store = new OmpRuntimeStore({ threadId });
    const call = assistantMessage([
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "pwd" } },
    ]);
    const hidden = customMessage({
      customType: "mid-run-todo-nudge",
      display: false,
      timestamp: 5,
    });
    const result = toolResultMessage("t1");
    const shown = customMessage({ timestamp: 6 });
    for (const [index, message] of [call, hidden, result, shown].entries()) {
      ompEvent(store, { type: "message_start", messageId: `m${index}`, message }, index * 2 + 1);
      ompEvent(store, { type: "message_end", messageId: `m${index}`, message }, index * 2 + 2);
    }
    const runtime = createOmpRuntime({
      store,
      send: (() => Promise.resolve()) as unknown as ChatSessionRequest,
    });
    const views = runtime.messages();
    // The hidden message is left out, and the tool result still belongs to the call before it.
    expect(views.map((view) => view.record.message.role)).toEqual([
      "assistant",
      "toolResult",
      "custom",
    ]);
    expect(views[1]?.toolResultMatched).toBe(true);
    // It is still saved in the store: it is only left out of what the page shows.
    expect(Object.keys(store.getSnapshot().messages)).toHaveLength(4);
  });

  test("an answer that ended in an error keeps omp's words on its status; an interruption and the length limit have their own", () => {
    const status = (overrides: Record<string, unknown>) =>
      convertMessage(
        runtimeMessage(
          { ...assistantMessage([]), ...overrides } as OmpMessage,
          "entry:runtime-test-thread:ending",
        ) as RuntimeMessageView["record"],
      ) as { status?: unknown };
    expect(status({ stopReason: "error", errorMessage: " 404 model not found " }).status).toEqual({
      type: "incomplete",
      reason: "error",
      error: "404 model not found",
    });
    expect(status({ stopReason: "error" }).status).toEqual({ type: "incomplete", reason: "error" });
    expect(status({ stopReason: "aborted", errorMessage: "Interrupted by user" }).status).toEqual({
      type: "incomplete",
      reason: "cancelled",
    });
    expect(status({ stopReason: "length" }).status).toEqual({
      type: "incomplete",
      reason: "length",
    });
  });

  test("an error that omp retried and recovered from is a finished message, not a failure", () => {
    const retried: Record<string, unknown> = {
      ...assistantMessage([]),
      stopReason: "error",
      errorMessage: "stream stalled",
      retryRecovery: {
        kind: "auto-retry",
        status: "recovered",
        attempt: 1,
        recoveredAt: "2026-10-18T00:00:01.000Z",
        recovery: "wait",
        note: "error; retried",
        supersededBy: {
          timestamp: "2026-10-18T00:00:02.000Z",
          provider: "fake",
          model: "fake-model",
        },
      },
    };
    const converted = convertMessage(
      runtimeMessage(
        retried as unknown as OmpMessage,
        "entry:runtime-test-thread:retried",
      ) as RuntimeMessageView["record"],
    );
    const message = converted as ThreadMessageLike;
    expect(message.status).toEqual({ type: "complete", reason: "unknown" });
    expect(message.metadata?.custom?.ompRetryRecovery).toEqual({
      status: "recovered",
      note: "error; retried",
    });
    expect(retryRecoveryNote({ status: "recovered", note: "rate-limited; waited; retried" })).toBe(
      "rate-limited; waited; retried",
    );
    expect(retryRecoveryNote({ status: "superseded", note: "error; retried" })).toBeUndefined();
    expect(retryRecoveryNote({ status: "recovered", note: "" })).toBeUndefined();
  });

  test("ignores recovered markers whose note is missing or not text", () => {
    expect(retryRecoveryNote({ status: "recovered" })).toBeUndefined();
    expect(retryRecoveryNote({ status: "recovered", note: 42 })).toBeUndefined();
  });
  test("carries omp's stripped tool-call count into assistant metadata", () => {
    expect(strippedToolCallsCount({ strippedToolCalls: 2 })).toBe(2);
    expect(strippedToolCallsCount(0)).toBeUndefined();
    const converted = convertMessage(
      runtimeMessage(
        { ...assistantMessage([]), strippedToolCalls: 2 } as unknown as OmpMessage,
        "entry:runtime-test-thread:elided",
      ) as RuntimeMessageView["record"],
    ) as ThreadMessageLike;
    expect(converted.metadata?.custom?.ompStrippedToolCalls).toBe(2);
  });
});

describe("a call the person stopped", () => {
  const callPart = {
    type: "toolCall" as const,
    id: "tool-1",
    name: "bash",
    arguments: { command: "sleep 7" },
    rawBlock: '{"command":"sleep 7"}',
  };
  const errored = { ...toolResultMessage("tool-1", "bash", "Command aborted"), isError: true };
  const stopped = {
    ...assistantMessage([]),
    stopReason: "aborted",
    errorMessage: "Interrupted by user",
  } as OmpMessage;

  function snapshotOf(messages: readonly OmpMessage[]) {
    const keys = messages.map((_, index) => `entry:runtime-test-thread:s${index}` as MessageKey);
    const records = Object.fromEntries(
      messages.map((message, index) => [keys[index], runtimeMessage(message, keys[index])]),
    );
    return { messageOrder: keys, messages: records } as unknown as Parameters<
      typeof stoppedToolCallIds
    >[0];
  }

  test("names the call whose error result comes right before the stopped turn's end", () => {
    expect(
      stoppedToolCallIds(snapshotOf([assistantMessage([callPart]), errored, stopped])),
    ).toEqual(["tool-1"]);
  });

  test("a call whose result succeeded is not stopped, even when the turn was stopped later", () => {
    const succeeded = toolResultMessage("tool-1", "bash", "done");
    expect(
      stoppedToolCallIds(snapshotOf([assistantMessage([callPart]), succeeded, stopped])),
    ).toEqual([]);
  });

  test("an aborted record that carries an answer does not stop the calls before it", () => {
    const answered = {
      ...assistantMessage([{ type: "text", text: "partial answer" }]),
      stopReason: "aborted",
      errorMessage: "Interrupted by user",
    } as OmpMessage;
    expect(
      stoppedToolCallIds(snapshotOf([assistantMessage([callPart]), errored, answered])),
    ).toEqual([]);
  });

  test("a stopped call converts to a cancelled card state, not a failure, and keeps omp's result", () => {
    const record = runtimeMessage(assistantMessage([callPart]), "entry:runtime-test-thread:call");
    const failed = {
      toolCallId: "tool-1" as never,
      toolName: "bash",
      args: { command: "sleep 7" },
      status: "error" as const,
      result: { content: [{ type: "text", text: "Command aborted" }], details: {} },
      isError: true,
    };
    const toolParts = (view: RuntimeMessageView) =>
      messageParts(convertMessage(view)).filter((part) => part.type === "tool-call");

    expect(
      toolParts({
        record,
        toolStates: [{ toolCallId: "tool-1", state: failed }],
        stoppedToolCallIds: ["tool-1"],
      }),
    ).toEqual([
      expect.objectContaining({ status: "cancelled", isError: false, result: failed.result }),
    ]);
    expect(toolParts({ record, toolStates: [{ toolCallId: "tool-1", state: failed }] })).toEqual([
      expect.objectContaining({ status: "error", isError: true }),
    ]);
  });

  test("a reopened chat, with no live state for the call, still reads the stopped call as cancelled", () => {
    const record = runtimeMessage(errored, "entry:runtime-test-thread:stopped-result");
    const [part] = messageParts(
      convertMessage({
        record,
        toolStates: [{ toolCallId: "tool-1", state: undefined }],
        stoppedToolCallIds: ["tool-1"],
      }),
    ).filter((candidate) => candidate.type === "tool-call");
    expect(part).toEqual(
      expect.objectContaining({
        isError: false,
        toolState: expect.objectContaining({ status: "cancelled" }),
      }),
    );
  });

  test("a branch with a call and no result is finished as cancelled after the turn ends", () => {
    const record = runtimeMessage(
      assistantMessage([callPart]),
      "entry:runtime-test-thread:no-result",
    );
    const [part] = messageParts(
      convertMessage({
        record,
        toolStates: [{ toolCallId: "tool-1", state: undefined }],
        stoppedToolCallIds: ["tool-1"],
      }),
    ).filter((candidate) => candidate.type === "tool-call");
    expect(part).toEqual(
      expect.objectContaining({
        isError: false,
        toolState: expect.objectContaining({ status: "cancelled" }),
      }),
    );
    expect(part?.result).toBeUndefined();
  });
});
