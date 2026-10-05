import { fromThreadMessageLike, type ThreadMessageLike } from "@assistant-ui/react";
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
import { render, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { RuntimeMessage } from "../store/store";
import { OmpRuntimeStore } from "../store/store";
import {
  convertMessage,
  createOmpRuntime,
  type RuntimeMessageView,
  useOmpRuntime,
} from "./runtime";

const threadId = "runtime-test-thread" as ThreadId;
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
    expect(result.result.current).toBeDefined();
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
});
