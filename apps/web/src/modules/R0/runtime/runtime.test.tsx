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
  MessageKey,
  OmpMessage,
  RpcSessionEvent,
  RpcSessionSend,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { RuntimeMessage } from "../store/store";
import { OmpRuntimeStore } from "../store/store";
import {
  convertExternalMessage,
  convertMessage,
  createOmpRuntime,
  type RuntimeMessageView,
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
  store.ingest({ kind: "omp", event } as RpcSessionEvent, seq);
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
    const send: RpcSessionSend = async () => undefined as never;
    const controller = createOmpRuntime({ store, send, capabilities });
    const firstAdapter = controller.createAdapter();
    const firstView = (firstAdapter.messages ?? [])[0];
    if (!firstView) throw new Error("expected a message view");
    const firstConverted = firstAdapter.convertMessage(firstView, 0);

    store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 2);
    const secondAdapter = controller.createAdapter();
    const secondView = (secondAdapter.messages ?? [])[0];
    if (!secondView) throw new Error("expected a message view");
    expect(secondView).toBe(firstView);
    expect(secondAdapter.convertMessage(secondView, 0)).toBe(firstConverted);
  });

  test("submits through the typed prompt port and resolves at admission", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const calls: Array<{ readonly command: unknown }> = [];
    let admit!: (value: unknown) => void;
    const send: RpcSessionSend = async (args) => {
      calls.push({ command: args.command });
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
    expect(calls).toEqual([{ command: { type: "prompt", message: "hello" } }]);
    let settled = false;
    void submission.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    admit({ agentInvoked: true });
    await expect(submission).resolves.toBeUndefined();
  });

  test("preserves a pre-admission AppFailure and does not swallow its code", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const failure = new AppFailure({
      code: "permission",
      message: "Prompt was refused",
      retryable: false,
    } satisfies AppError);
    const send: RpcSessionSend = async () => {
      throw failure;
    };
    const controller = createOmpRuntime({ store, send, capabilities });
    await expect(
      controller.submitPrompt({ mode: "prompt", text: "keep this", delivery: "new" }),
    ).rejects.toBe(failure);
  });

  test("gates Python without sending a replacement prompt", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const commands: unknown[] = [];
    const send: RpcSessionSend = async ({ command }) => {
      commands.push(command);
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
  test("maps cancel to omp abort and hides unavailable actions", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const commands: unknown[] = [];

    const send: RpcSessionSend = async ({ command }) => {
      commands.push(command);
      return undefined as never;
    };
    const available = createOmpRuntime({ store, send, capabilities }).createAdapter();
    expect(available.onCancel).toBeTypeOf("function");
    await available.onCancel?.();
    expect(commands).toEqual([{ type: "abort" }]);

    const unavailable = createOmpRuntime({ store, send, capabilities: {} }).createAdapter();
    expect(unavailable.onCancel).toBeUndefined();
    expect(unavailable.onRefetchThread).toBeUndefined();
    expect(unavailable.unstable_enableToolInvocations).toBe(false);
  });

  test("rejects slash commands while streaming instead of steering their text", async () => {
    const store = new OmpRuntimeStore({ threadId });
    ompEvent(store, { type: "agent_start" }, 1);
    const commands: unknown[] = [];
    const send: RpcSessionSend = async ({ command }) => {
      commands.push(command);
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
    const send: RpcSessionSend = async ({ command }) => {
      commands.push(command);
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
      { type: "prompt", message: "also check the tests", streamingBehavior: "steer" },
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
    const send: RpcSessionSend = async ({ command }) => {
      commands.push(command);
      if (command.type === "bash") {
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
    expect(commands).toEqual([{ type: "bash", command: "printf hello" }, { type: "abort_bash" }]);
    finish(undefined);
    await expect(bash).resolves.toBeUndefined();
  });

  test("uses prompt_result for running state without conflating session_settled", () => {
    const store = new OmpRuntimeStore({ threadId });
    const send: RpcSessionSend = async () => undefined as never;
    const controller = createOmpRuntime({ store, send, capabilities });
    ompEvent(store, { type: "agent_start" }, 1);
    expect(controller.createAdapter().isRunning).toBe(true);
    store.ingest(
      {
        kind: "prompt_result",
        event: {
          type: "prompt_result",
          agentInvoked: true,
          status: "completed",
          sessionSettled: false,
        },
      } as RpcSessionEvent,
      2,
    );
    expect(controller.createAdapter().isRunning).toBe(false);
    expect(store.getSnapshot().prompt.sessionSettled).toBe(false);
    store.ingest(
      { kind: "session_settled", event: { type: "session_settled" } } as RpcSessionEvent,
      3,
    );
    expect(store.getSnapshot().prompt.sessionSettled).toBe(true);
  });

  test("installs the external-store runtime through the React hook", () => {
    const store = new OmpRuntimeStore({ threadId });
    const send: RpcSessionSend = async () => undefined as never;
    const result = renderHook(() => useOmpRuntime({ store, send, capabilities }));
    expect(result.result.current.runtime).toBeDefined();
    expect(result.result.current.controller).toBeInstanceOf(Object);
    result.unmount();
  });
  test("installs the supplied attachment adapter in the external composer runtime", async () => {
    const store = new OmpRuntimeStore({ threadId });
    const send: RpcSessionSend = async () => undefined as never;
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
      send: (() => Promise.resolve()) as unknown as RpcSessionSend,
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
        note: "error; retried",
      },
    };
    const converted = convertMessage(
      runtimeMessage(
        retried as unknown as OmpMessage,
        "entry:runtime-test-thread:retried",
      ) as RuntimeMessageView["record"],
    ) as { status?: unknown };
    expect(converted.status).toEqual({ type: "complete", reason: "unknown" });
  });
});
