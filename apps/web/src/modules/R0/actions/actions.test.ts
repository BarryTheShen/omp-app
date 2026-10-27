import type {
  AnswerHostRequestArgs,
  AppError,
  CapabilityMap,
  HostToolResponse,
  HostUriResponse,
  RpcSessionSend,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { dialogEvent, notificationEvent } from "@/modules/R0/store/session-events";
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

function notification(store: OmpRuntimeStore, frame: unknown, seq: number): void {
  store.ingest(notificationEvent(frame), seq);
}

/** A dialog the host asks: an input named "Name". */
function askName(store: OmpRuntimeStore, seq: number): void {
  store.ingest(dialogEvent({ id: "ui-1", method: "ui.input", params: { title: "Name" } }), seq);
}

function makeStore(
  answerHandlers: {
    dialog?: (args: AnswerHostRequestArgs) => Promise<void>;
    hostTool?: (response: HostToolResponse) => Promise<void>;
    hostUri?: (response: HostUriResponse) => Promise<void>;
  } = {},
): OmpRuntimeStore {
  return new OmpRuntimeStore({
    threadId,
    transport: {
      answer: async (args: AnswerHostRequestArgs) => {
        await answerHandlers.dialog?.(args);
        return null;
      },
      answerHostTool: async ({ response }: { readonly response: HostToolResponse }) => {
        await answerHandlers.hostTool?.(response);
        return null;
      },
      answerHostUri: async ({ response }: { readonly response: HostUriResponse }) => {
        await answerHandlers.hostUri?.(response);
        return null;
      },
    } as OmpRuntimeTransport,
  });
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
    const answered: unknown[] = [];
    const store = makeStore({
      dialog: async (args) => {
        answered.push(args);
      },
      hostTool: async (response) => {
        answered.push(response);
      },
      hostUri: async (response) => {
        answered.push(response);
      },
    });
    askName(store, 1);
    notification(
      store,
      {
        type: "host_tool_call",
        id: "host-1",
        toolCallId: "call-1",
        toolName: "read",
        arguments: {},
      },
      2,
    );
    notification(
      store,
      { type: "host_uri_request", id: "uri-1", operation: "read", url: "https://example.test" },
      3,
    );
    const send: RpcSessionSend = async () => undefined as never;
    const controller = createQueueController({ store, send, capabilities });
    const hostResponse = {
      id: "host-1",
      type: "host_tool_result",
      result: { content: [{ type: "text", text: "done" }] },
    } as HostToolResponse;
    const uriResponse = {
      id: "uri-1",
      type: "host_uri_result",
      url: "https://example.test",
      content: "ok",
    } as unknown as HostUriResponse;
    await expect(controller.answerDialog("ui-gone", { value: "ok" })).rejects.toMatchObject({
      appError: { code: "not_found" },
    });
    await controller.answerDialog("ui-1", { value: "ok" });
    await controller.answerHostTool(hostResponse);
    await controller.answerHostUri(uriResponse);
    expect(answered).toEqual([
      { threadId, id: "ui-1", answer: { value: "ok" } },
      hostResponse,
      uriResponse,
    ]);
    expect(store.getSnapshot().pending.dialogs).toEqual({});
    expect(store.getSnapshot().pending.hostTools).toEqual({});
    expect(store.getSnapshot().pending.hostUris).toEqual({});
  });

  test("rejects a second answer while the first answer is in flight", async () => {
    let resolveAnswer!: () => void;
    const store = makeStore({
      dialog: () =>
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
    const answered: HostToolResponse[] = [];
    const store = makeStore({
      hostTool: async (response) => {
        answered.push(response);
      },
    });
    notification(
      store,
      {
        type: "host_tool_call",
        id: "host-1",
        toolCallId: "call-1",
        toolName: "read",
        arguments: {},
      },
      1,
    );
    const send: RpcSessionSend = async () => undefined as never;
    const controller = createQueueController({ store, send, capabilities });
    await controller.onAddToolResult({
      messageId: "message-1",
      toolName: "read",
      toolCallId: "call-1",
      result: "done",
      isError: false,
    });
    expect(answered[0]).toMatchObject({
      type: "host_tool_result",
      id: "host-1",
      result: { content: [{ type: "text", text: "done" }] },
    });
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
