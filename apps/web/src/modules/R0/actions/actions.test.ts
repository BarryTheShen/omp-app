import type {
  AnswerHostRequestArgs,
  AppError,
  CapabilityMap,
  RpcSessionSend,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { HostToolUpdateParams } from "@omp-app/contracts/chat-host";
import { describe, expect, test } from "vitest";
import { dialogEvent, hostCallEvent } from "@/modules/R0/store/session-events";
import { OmpRuntimeStore, type OmpRuntimeTransport } from "../store/store";
import { createQueueController, type QueueSnapshot } from "./actions";

const threadId = "r0-5-thread" as ThreadId;
const capabilities: CapabilityMap = {
  "omp.cmd.steer": { state: "available", via: "rpc" },
  "omp.cmd.follow_up": { state: "available", via: "rpc" },
  "omp.cmd.remove_queued_message": { state: "available", via: "rpc" },
  "omp.cmd.promote_queued_message": { state: "available", via: "rpc" },
  "omp.cmd.set_steering_mode": { state: "available", via: "rpc" },
  "omp.cmd.set_follow_up_mode": { state: "available", via: "rpc" },
  "omp.cmd.set_interrupt_mode": { state: "available", via: "rpc" },
  "omp.ui": { state: "available", via: "rpc" },
  "omp.host-tools": { state: "available", via: "rpc" },
  "omp.host-uris": { state: "available", via: "rpc" },
};

/** A dialog the host asks: an input named "Name". */
function askName(store: OmpRuntimeStore, seq: number): void {
  store.ingest(dialogEvent({ id: "ui-1", method: "ui.input", params: { title: "Name" } }), seq);
}

/** A call of the app's `read` tool the host makes, as the model's call `call-1`. */
function callRead(store: OmpRuntimeStore, seq: number): void {
  store.ingest(
    hostCallEvent({
      id: "host-1",
      method: "tool.call",
      params: { toolCallId: "call-1", toolName: "read", arguments: {} },
    }),
    seq,
  );
}

function makeStore(
  handlers: {
    answer?: (args: AnswerHostRequestArgs) => Promise<void>;
    update?: (params: HostToolUpdateParams) => Promise<boolean>;
  } = {},
): OmpRuntimeStore {
  const transport: OmpRuntimeTransport = {
    answer: async (args) => {
      await handlers.answer?.(args);
      return null;
    },
    updateHostTool: async ({ params }) => ({
      delivered: (await handlers.update?.(params)) ?? true,
    }),
  };
  return new OmpRuntimeStore({ threadId, transport });
}

describe("R0.5 QueueController", () => {
  test("derives one queue snapshot from R0.1 and notifies subscribers", () => {
    const store = makeStore();
    const send: RpcSessionSend = async () => undefined as never;
    const controller = createQueueController({ store, send, capabilities });
    const snapshots: QueueSnapshot[] = [];
    const unsubscribe = controller.subscribe((snapshot) => snapshots.push(snapshot));
    store.applySessionState({
      isStreaming: true,
      steeringMode: "one-at-a-time",
      followUpMode: "all",
      interruptMode: "wait",
      queuedMessages: { steering: ["s1"], followUp: ["f1", "f2"] },
    });
    expect(controller.getSnapshot()).toEqual({
      steering: ["s1"],
      followUp: ["f1", "f2"],
      steeringMode: "one-at-a-time",
      followUpMode: "all",
      interruptMode: "wait",
      liveSteered: 0,
      isStreaming: true,
    });
    expect(snapshots.at(-1)?.steering).toEqual(["s1"]);
    unsubscribe();
  });

  test("submits steer and follow-up through their queue commands", async () => {
    const store = makeStore();
    const commands: unknown[] = [];
    const send: RpcSessionSend = async ({ command }) => {
      commands.push(command);
      return undefined as never;
    };
    const controller = createQueueController({ store, send, capabilities });
    await controller.submit({ text: "steer me", delivery: "steer" });
    await controller.submit({ text: "follow me", delivery: "followUp" });
    expect(commands).toEqual([
      { type: "steer", message: "steer me" },
      { type: "follow_up", message: "follow me" },
    ]);
  });

  test("keeps a pre-admission queue failure typed for draft recovery", async () => {
    const store = makeStore();
    const failure = new AppFailure({
      code: "permission",
      message: "Queue admission was refused",
      retryable: false,
    } satisfies AppError);
    const send: RpcSessionSend = async () => {
      throw failure;
    };
    const controller = createQueueController({ store, send, capabilities });
    await expect(controller.submit({ text: "keep me", delivery: "followUp" })).rejects.toBe(
      failure,
    );
  });

  test("removes and promotes without maintaining a second queue array", async () => {
    const store = makeStore();
    const commands: unknown[] = [];
    const send: RpcSessionSend = async ({ command }) => {
      commands.push(command);
      if (command.type === "remove_queued_message") return { removed: false } as never;
      return { promoted: true } as never;
    };
    const controller = createQueueController({ store, send, capabilities });
    await expect(controller.remove({ lane: "followUp", message: "stale" })).resolves.toEqual({
      changed: false,
    });
    await expect(controller.promote("next")).resolves.toEqual({ changed: true });
    expect(commands).toEqual([
      { type: "remove_queued_message", message: "stale", queue: "followUp" },
      { type: "promote_queued_message", message: "next" },
    ]);
    expect(controller.getSnapshot().followUp).toEqual([]);
  });
  test("returns restored images and the transport-omission marker only for a removed message", async () => {
    const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" } as const;
    const store = makeStore();
    let response: unknown = { removed: true, images: [image] };
    const send: RpcSessionSend = async () => response as never;
    const controller = createQueueController({ store, send, capabilities });

    await expect(controller.remove({ lane: "followUp", message: "with image" })).resolves.toEqual({
      changed: true,
      images: [image],
    });
    response = { removed: true, imagesDropped: true };
    await expect(controller.remove({ lane: "followUp", message: "large image" })).resolves.toEqual({
      changed: true,
      imagesDropped: true,
    });
    response = { removed: false, imagesDropped: true, images: [image] };
    await expect(controller.remove({ lane: "followUp", message: "already gone" })).resolves.toEqual(
      {
        changed: false,
      },
    );
  });

  test("preserves a not_found mutation failure for a message omp already dequeued", async () => {
    const store = makeStore();
    const failure = new AppFailure({
      code: "not_found",
      message: "queued message was already dequeued",
      retryable: false,
    } satisfies AppError);
    const send: RpcSessionSend = async () => {
      throw failure;
    };
    const controller = createQueueController({ store, send, capabilities });
    await expect(controller.remove({ lane: "steering", message: "gone" })).rejects.toBe(failure);
  });

  test("changes queue modes in deterministic command order", async () => {
    const store = makeStore();
    const commands: unknown[] = [];
    const send: RpcSessionSend = async ({ command }) => {
      commands.push(command);
      return undefined as never;
    };
    const controller = createQueueController({ store, send, capabilities });
    await controller.setModes({
      steeringMode: "one-at-a-time",
      followUpMode: "all",
      interruptMode: "wait",
    });
    expect(commands).toEqual([
      { type: "set_steering_mode", mode: "one-at-a-time" },
      { type: "set_follow_up_mode", mode: "all" },
      { type: "set_interrupt_mode", mode: "wait" },
    ]);
  });

  test("routes dialog, host-tool, and host-URI answers only for pending requests", async () => {
    const answered: AnswerHostRequestArgs[] = [];
    const store = makeStore({
      answer: async (args) => {
        answered.push(args);
      },
    });
    askName(store, 1);
    callRead(store, 2);
    store.ingest(
      hostCallEvent({ id: "uri-1", method: "uri.read", params: { url: "app://notes/a" } }),
      3,
    );
    const send: RpcSessionSend = async () => undefined as never;
    const controller = createQueueController({ store, send, capabilities });
    const toolResult = { content: [{ type: "text" as const, text: "done" }] };
    await expect(controller.answerDialog("ui-gone", { value: "ok" })).rejects.toMatchObject({
      appError: { code: "not_found" },
    });
    await expect(controller.answerHostTool("host-gone", toolResult)).rejects.toMatchObject({
      appError: { code: "not_found" },
    });
    await expect(controller.answerHostUri("uri-gone", { content: "ok" })).rejects.toMatchObject({
      appError: { code: "not_found" },
    });
    await controller.answerDialog("ui-1", { value: "ok" });
    await controller.answerHostTool("host-1", toolResult);
    await controller.answerHostUri("uri-1", { content: "ok" });
    expect(answered).toEqual([
      { threadId, id: "ui-1", answer: { value: "ok" } },
      { threadId, id: "host-1", answer: toolResult },
      { threadId, id: "uri-1", answer: { content: "ok" } },
    ]);
    expect(store.getSnapshot().pending.dialogs).toEqual({});
    expect(store.getSnapshot().pending.hostTools).toEqual({});
    expect(store.getSnapshot().pending.hostUris).toEqual({});
  });

  test("a tool's progress is sent as the host's update, and the call stays open for its result", async () => {
    const updates: HostToolUpdateParams[] = [];
    const store = makeStore({
      update: async (params) => {
        updates.push(params);
        return true;
      },
    });
    callRead(store, 1);
    const send: RpcSessionSend = async () => undefined as never;
    const controller = createQueueController({ store, send, capabilities });
    const partialResult = { content: [{ type: "text" as const, text: "half" }] };
    await expect(controller.updateHostTool("host-1", partialResult)).resolves.toBe(true);
    expect(updates).toEqual([{ callId: "host-1", partialResult }]);
    expect(Object.keys(store.getSnapshot().pending.hostTools)).toEqual(["host-1"]);
  });

  test("rejects a second answer while the first answer is in flight", async () => {
    let resolveAnswer!: () => void;
    const store = makeStore({
      answer: () =>
        new Promise<void>((resolve) => {
          resolveAnswer = resolve;
        }),
    });
    askName(store, 1);
    const send: RpcSessionSend = async () => undefined as never;
    const controller = createQueueController({ store, send, capabilities });
    const first = controller.answerDialog("ui-1", { value: "ok" });
    await Promise.resolve();
    await expect(controller.answerDialog("ui-1", { value: "ok" })).rejects.toMatchObject({
      appError: { code: "conflict" },
    });
    resolveAnswer();
    await expect(first).resolves.toBeUndefined();
  });

  test("maps assistant-ui host-tool results through the typed answer seam", async () => {
    const answered: AnswerHostRequestArgs[] = [];
    const store = makeStore({
      answer: async (args) => {
        answered.push(args);
      },
    });
    callRead(store, 1);
    const send: RpcSessionSend = async () => undefined as never;
    const controller = createQueueController({ store, send, capabilities });
    await controller.onAddToolResult({
      messageId: "message-1",
      toolName: "read",
      toolCallId: "call-1",
      result: "done",
      isError: false,
    });
    expect(answered).toEqual([
      { threadId, id: "host-1", answer: { content: [{ type: "text", text: "done" }] } },
    ]);
  });

  test("capability failures are typed and do not send commands", async () => {
    const store = makeStore();
    let sent = false;
    const send: RpcSessionSend = async () => {
      sent = true;
      return undefined as never;
    };
    const controller = createQueueController({ store, send, capabilities: {} });
    await expect(controller.submit({ text: "queued", delivery: "steer" })).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "omp.cmd.steer" },
    });
    expect(sent).toBe(false);
  });
});
