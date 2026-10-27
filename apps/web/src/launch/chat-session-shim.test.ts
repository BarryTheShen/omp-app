import type { AppClient } from "@omp-app/client";
import {
  AppPort,
  type CapabilityMap,
  type ChatSessionEvent,
  ChatSessionPort,
  type RpcSessionEvent,
  RpcSessionPort,
  ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { requestOf, resultOf, rpcEventOf } from "../modules/R0/store/rpc-frames";
import { withChatSessionShim } from "./chat-session-shim";

const thread = ThreadId.parse("thread-shim");

function event(payload: ChatSessionEvent): RpcSessionEvent {
  return rpcEventOf(payload);
}

function chatEvent(value: Record<string, unknown>): ChatSessionEvent {
  return { kind: "event", event: value } as unknown as ChatSessionEvent;
}

function hostRequest(
  id: string,
  method: string,
  params: Record<string, unknown>,
): ChatSessionEvent {
  return { kind: "host_request", request: { id, method, params } } as unknown as ChatSessionEvent;
}

describe("the cutover shim's events: each session payload as the RPC event omp's RPC session made of it", () => {
  test("omp's own session events stay omp events, and the host's other events become notification frames", () => {
    expect(event(chatEvent({ type: "agent_start" }))).toEqual({
      kind: "omp",
      event: { type: "agent_start" },
    });
    expect(event(chatEvent({ type: "goal_updated", goal: null }))).toEqual({
      kind: "omp",
      event: { type: "goal_updated", goal: null },
    });
    expect(event(chatEvent({ type: "command_output", text: "Session: 1" }))).toEqual({
      kind: "notification",
      frame: { type: "command_output", text: "Session: 1" },
    });
    expect(event(chatEvent({ type: "subagent_progress", payload: {} }))).toMatchObject({
      kind: "notification",
      frame: { type: "subagent_progress" },
    });
  });

  test("the command list keeps omp's RPC name, available_commands_update", () => {
    const commands = [{ name: "session" }];
    expect(event(chatEvent({ type: "available_commands", commands }))).toEqual({
      kind: "notification",
      frame: { type: "available_commands_update", commands },
    });
  });

  test("a prompt's result keeps its request id, and the settle report is a kind of its own", () => {
    expect(
      event(
        chatEvent({
          type: "prompt_result",
          requestId: "4",
          agentInvoked: true,
          status: "error",
          sessionSettled: true,
          error: { message: "quota", retryable: false },
        }),
      ),
    ).toEqual({
      kind: "prompt_result",
      event: {
        type: "prompt_result",
        id: "4",
        agentInvoked: true,
        status: "error",
        sessionSettled: true,
        error: { message: "quota", retryable: false },
      },
    });
    expect(event(chatEvent({ type: "session_settled" }))).toEqual({
      kind: "session_settled",
      event: { type: "session_settled" },
    });
  });

  test("each UI event passes as itself, and a dialog's cancel names the dialog it closes", () => {
    const uiEvents: readonly Record<string, unknown>[] = [
      { type: "ui_notify", message: "Saved", notifyType: "info" },
      { type: "ui_status", statusKey: "git", statusText: "main" },
      { type: "ui_widget", widgetKey: "w", widgetLines: ["a"] },
      { type: "ui_title", title: "Fix" },
      { type: "ui_editor_text", text: "draft" },
      { type: "ui_open_url", url: "https://x.test" },
    ];
    for (const uiEvent of uiEvents) {
      expect(event(chatEvent(uiEvent))).toEqual({ kind: "notification", frame: uiEvent });
    }
    expect(event(chatEvent({ type: "ui_cancel", requestId: "9" }))).toEqual({
      kind: "notification",
      frame: { type: "host_dialog_cancel", requestId: "9" },
    });
  });

  test("a dialog is the host's request, unchanged; an approval keeps omp's typed prompt", () => {
    const confirm = { title: "Sure?", message: "Delete it", timeout: 5 };
    expect(event(hostRequest("3", "ui.confirm", confirm))).toEqual({
      kind: "notification",
      frame: { type: "host_dialog", request: { id: "3", method: "ui.confirm", params: confirm } },
    });
    const prompt = { full: "Allow write to src/a.ts?", compact: "Allow write?" };
    expect(event(hostRequest("5", "ui.approve", { prompt, timeout: 60 }))).toEqual({
      kind: "notification",
      frame: {
        type: "host_dialog",
        request: { id: "5", method: "ui.approve", params: { prompt, timeout: 60 } },
      },
    });
  });

  test("a tool call or a URI read or write is the host's request, unchanged; its cancel names the call", () => {
    const call = { toolCallId: "c1", toolName: "lookup", arguments: { q: 1 } };
    expect(event(hostRequest("8", "tool.call", call))).toEqual({
      kind: "notification",
      frame: { type: "host_call", request: { id: "8", method: "tool.call", params: call } },
    });
    expect(event(hostRequest("9", "uri.read", { url: "app://a" }))).toEqual({
      kind: "notification",
      frame: {
        type: "host_call",
        request: { id: "9", method: "uri.read", params: { url: "app://a" } },
      },
    });
    expect(event(hostRequest("10", "uri.write", { url: "app://a", content: "x" }))).toEqual({
      kind: "notification",
      frame: {
        type: "host_call",
        request: { id: "10", method: "uri.write", params: { url: "app://a", content: "x" } },
      },
    });
    expect(event(chatEvent({ type: "tool_cancel", requestId: "8" }))).toEqual({
      kind: "notification",
      frame: { type: "host_call_cancel", requestId: "8" },
    });
    expect(event(chatEvent({ type: "uri_cancel", requestId: "9" }))).toEqual({
      kind: "notification",
      frame: { type: "host_call_cancel", requestId: "9" },
    });
  });

  test("a ! run is A0's bash event with omp's result fields, and a session switch is the update A0 sent", () => {
    expect(
      event({
        kind: "shell",
        method: "bash",
        input: "ls",
        status: "ended",
        startedAt: 100,
        result: {
          output: "a\n",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          artifactId: "art",
        },
      } as ChatSessionEvent),
    ).toEqual({
      kind: "bash",
      status: "ended",
      command: "ls",
      startedAt: 100,
      result: { output: "a\n", exitCode: 0, cancelled: false, truncated: false },
    });
    expect(
      event({
        kind: "moved",
        threadId: "thread-new",
        sessionFile: "/s/new.jsonl",
      } as unknown as ChatSessionEvent),
    ).toEqual({
      kind: "notification",
      frame: { type: "session_info_update", sessionId: "thread-new" },
    });
    expect(event({ kind: "process", status: "ready", startedAt: 5 } as ChatSessionEvent)).toEqual({
      kind: "process",
      status: "ready",
      startedAt: 5,
    });
  });
});

describe("the cutover shim's sends and answers", () => {
  test("prompt, steer and follow_up send omp's message as the host's text; other commands pass unchanged", () => {
    for (const type of ["prompt", "steer", "follow_up"]) {
      expect(requestOf({ type, message: "hi", images: [] })).toEqual({
        method: type,
        params: { text: "hi", images: [] },
      });
    }
    expect(requestOf({ type: "set_model", provider: "p", modelId: "m" })).toEqual({
      method: "set_model",
      params: { provider: "p", modelId: "m" },
    });
  });

  test("a prompt's answer says whether the model runs; other results pass unchanged", () => {
    expect(resultOf("prompt", { resultFollows: false })).toEqual({ agentInvoked: false });
    expect(resultOf("prompt", { resultFollows: true })).toEqual({ agentInvoked: true });
    expect(resultOf("get_tree", { nodes: [] })).toEqual({ nodes: [] });
  });
});

/** A connection client whose chat session port and subscription record what the shim does with them. */
function fakeConnection() {
  const calls: { readonly method: string; readonly args: unknown }[] = [];
  const listeners = new Set<(payload: ChatSessionEvent, seq: number) => void>();
  let capabilityReads = 0;
  const record =
    (method: string, answer: (args: unknown) => unknown = () => null) =>
    async (args: unknown) => {
      calls.push({ method, args });
      return answer(args);
    };
  const chat = {
    open: record("open", () => ({
      threadId: thread,
      sessionFile: "/s/a.jsonl",
      methods: ["prompt"],
    })),
    request: record("request", (args) =>
      (args as { method: string }).method === "prompt" ? { resultFollows: true } : { ok: true },
    ),
    answer: record("answer"),
  };
  const app = {
    capabilities: async (): Promise<CapabilityMap> => {
      capabilityReads += 1;
      return { "omp.ui": { state: "available", via: "rpc" } } as unknown as CapabilityMap;
    },
  };
  const other = { name: "A1.other" };
  const client = {
    connectionState: "open",
    instanceId: "i",
    onConnectionState: () => () => undefined,
    onResync: () => () => undefined,
    port: (port: { readonly name: string }) =>
      port.name === ChatSessionPort.name ? chat : port.name === AppPort.name ? app : other,
    subscribe: async (
      port: { readonly name: string },
      _event: string,
      options?: { onEvent?: (p: ChatSessionEvent, s: number) => void },
    ) => {
      calls.push({ method: `subscribe:${port.name}`, args: options });
      if (options?.onEvent) listeners.add(options.onEvent);
      return {
        stream: "s",
        lastSeq: 0,
        onEvent: (listener: (p: ChatSessionEvent, s: number) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        unsubscribe: async () => undefined,
      };
    },
    dispose: () => undefined,
  } as unknown as AppClient;
  return {
    client,
    calls,
    other,
    capabilityReads: () => capabilityReads,
    emit: (payload: ChatSessionEvent, seq: number) => {
      for (const listener of [...listeners]) listener(payload, seq);
    },
  };
}

describe("the cutover client: A0's RPC port served by the chat session port", () => {
  test("other ports pass through, and a send is a request by method", async () => {
    const connection = fakeConnection();
    const shimmed = withChatSessionShim(connection.client);
    expect(shimmed.port({ name: "A1.other" } as never)).toBe(connection.other);
    const rpc = shimmed.port(RpcSessionPort);
    expect(
      await rpc.send({ threadId: thread, command: { type: "prompt", message: "hi" } } as never),
    ).toEqual({
      agentInvoked: true,
    });
    expect(connection.calls.at(-1)).toEqual({
      method: "request",
      args: { threadId: thread, method: "prompt", params: { text: "hi" } },
    });
  });

  test("a listener given in the options and to the subscription hears each event once, translated", async () => {
    const connection = fakeConnection();
    const shimmed = withChatSessionShim(connection.client);
    const heard: RpcSessionEvent[] = [];
    const listener = (rpcEvent: RpcSessionEvent) => heard.push(rpcEvent);
    const subscription = await shimmed.subscribe(RpcSessionPort, "event", {
      scope: thread,
      onEvent: listener,
    });
    subscription.onEvent(listener);
    connection.emit(chatEvent({ type: "agent_start" }), 1);
    expect(heard).toEqual([{ kind: "omp", event: { type: "agent_start" } }]);
    expect(
      connection.calls.some(({ method }) => method === `subscribe:${ChatSessionPort.name}`),
    ).toBe(true);
  });

  test("an open answers with the app's capabilities, read once for the connection", async () => {
    const connection = fakeConnection();
    const rpc = withChatSessionShim(connection.client).port(RpcSessionPort);
    const first = await rpc.open({ folderPath: "/w", start: "new" } as never);
    await rpc.open({ threadId: thread } as never);
    expect(first).toEqual({
      threadId: thread,
      sessionFile: "/s/a.jsonl",
      capabilities: { "omp.ui": { state: "available", via: "rpc" } },
    });
    expect(connection.capabilityReads()).toBe(1);
  });

  test("the RPC port's answer methods are refused: omp's requests are answered and replayed on the chat session port", async () => {
    const connection = fakeConnection();
    const rpc = withChatSessionShim(connection.client).port(RpcSessionPort);
    const calls = connection.calls.length;
    const content = [{ type: "text", text: "half" }];
    const refused = { appError: { code: "unavailable" } };
    await expect(
      rpc.answerExtensionUi({
        threadId: thread,
        response: { type: "extension_ui_response", id: "5", value: "Deny" },
      } as never),
    ).rejects.toMatchObject(refused);
    await expect(rpc.openQuestions({ threadId: thread })).rejects.toMatchObject(refused);
    await expect(rpc.stateFrames({ threadId: thread })).rejects.toMatchObject(refused);
    await expect(
      rpc.answerHostTool({
        threadId: thread,
        response: { type: "host_tool_result", id: "8", result: { content } },
      } as never),
    ).rejects.toMatchObject(refused);
    await expect(
      rpc.answerHostUri({
        threadId: thread,
        response: { type: "host_uri_result", id: "9", content: "x" },
      } as never),
    ).rejects.toMatchObject(refused);
    expect(connection.calls).toHaveLength(calls);
  });
});
