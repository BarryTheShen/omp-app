import { describe, expect, test } from "bun:test";
import type { OmpCommandMap, OmpCommandName } from "../src";
import { FolderPath, OMP_COMMAND_NAMES, ThreadId } from "../src";
import type { RpcSessionSend, SendCommandArgs as TypedSendCommandArgs } from "../src/ports/A0";
import {
  AppHealth,
  AppPort,
  AppServerInfo,
  OpenThreadArgs,
  OpenThreadResult,
  ompCommandCapability,
  RpcSessionEvent,
  RpcSessionPort,
  rpcSessionEventStream,
  SendCommandArgs,
  SetEventFilterArgs,
  SetSubagentSubscriptionArgs,
  SubscribeResult,
} from "../src/ports/A0";

describe("RpcSessionPort", () => {
  const threadId = ThreadId.parse("thread-1");
  const folderPath = FolderPath.parse("/workspace/project");
  const sessionFile = "/workspace/project/.omp/session.jsonl";

  test("opens by thread id or explicit folder start intent and rejects malformed identities", () => {
    expect(OpenThreadArgs.safeParse({ threadId }).success).toBe(true);
    expect(OpenThreadArgs.safeParse({ folderPath, start: "new" }).success).toBe(true);
    expect(OpenThreadArgs.safeParse({ folderPath, start: "latest" }).success).toBe(true);
    expect(OpenThreadArgs.safeParse({ folderPath }).success).toBe(false);
    expect(OpenThreadArgs.safeParse({ folderPath, start: "resume" }).success).toBe(false);
    expect(OpenThreadArgs.safeParse({ threadId: "" }).success).toBe(false);
    expect(OpenThreadArgs.safeParse({ folderPath: "relative/path", start: "new" }).success).toBe(
      false,
    );
    expect(OpenThreadArgs.safeParse({}).success).toBe(false);
    expect(OpenThreadArgs.safeParse({ threadId, folderPath, start: "new" }).success).toBe(false);

    expect(
      OpenThreadResult.safeParse({
        threadId,
        sessionFile,
        capabilities: {
          "omp.cmd.prompt": { state: "available", via: "rpc" },
        },
      }).success,
    ).toBe(true);
    expect(
      OpenThreadResult.safeParse({
        threadId,
        sessionFile: "/workspace/project/session.txt",
        capabilities: {},
      }).success,
    ).toBe(false);
  });

  test("send requires per-owner metadata only for host registration commands", () => {
    for (const command of OMP_COMMAND_NAMES) {
      const registrationCommand =
        command === "set_host_tools" || command === "set_host_uri_schemes";
      expect(
        RpcSessionPort.methods.send.args.safeParse({
          threadId,
          command: { type: command },
          ...(registrationCommand ? { registrationOwner: "test-owner" } : {}),
        }).success,
      ).toBe(true);
    }

    expect(
      SendCommandArgs.safeParse({
        threadId,
        command: { type: "not_an_omp_command" },
      }).success,
    ).toBe(false);
    expect(SendCommandArgs.safeParse({ threadId }).success).toBe(false);
    expect(SendCommandArgs.safeParse({ threadId: "", command: { type: "prompt" } }).success).toBe(
      false,
    );
    expect(
      SendCommandArgs.safeParse({ threadId, command: { type: "prompt", id: "" } }).success,
    ).toBe(false);
    expect(
      SendCommandArgs.safeParse({
        threadId,
        command: { type: "set_host_tools", tools: [] },
      }).success,
    ).toBe(false);
    expect(
      SendCommandArgs.safeParse({
        threadId,
        registrationOwner: "test-owner",
        command: { type: "prompt" },
      }).success,
    ).toBe(false);
    expect(
      SendCommandArgs.safeParse({
        threadId,
        registrationOwner: "test-owner",
        command: { type: "set_host_tools", tools: [] },
      }).success,
    ).toBe(true);
  });

  test("keeps normalized event kinds and omp completion notifications distinct", () => {
    expect(RpcSessionEvent.safeParse({ kind: "omp", event: { type: "turn_start" } }).success).toBe(
      true,
    );
    expect(
      RpcSessionEvent.safeParse({
        kind: "prompt_result",
        event: {
          type: "prompt_result",
          agentInvoked: true,
          status: "completed",
          sessionSettled: false,
        },
      }).success,
    ).toBe(true);
    expect(
      RpcSessionEvent.safeParse({ kind: "session_settled", event: { type: "session_settled" } })
        .success,
    ).toBe(true);
    expect(RpcSessionEvent.safeParse({ kind: "process", status: "running" }).success).toBe(true);
    expect(
      RpcSessionEvent.safeParse({
        kind: "process",
        status: "error",
        error: { code: "omp_exited", message: "omp exited", retryable: false },
      }).success,
    ).toBe(true);
    expect(
      RpcSessionEvent.safeParse({ kind: "process", status: "error", error: "omp exited" }).success,
    ).toBe(false);

    const notificationTypes = [
      "extension_ui_request",
      "host_tool_call",
      "host_tool_cancel",
      "host_uri_request",
      "host_uri_cancel",
      "available_commands_update",
      "subagent_lifecycle",
      "subagent_progress",
      "subagent_event",
      "command_output",
      "session_info_update",
      "config_update",
      "extension_error",
      "rpc_frame_error",
      "live_phase",
      "live_levels",
      "live_transcript",
      "live_end",
    ];
    for (const type of notificationTypes) {
      expect(RpcSessionEvent.safeParse({ kind: "notification", frame: { type } }).success).toBe(
        true,
      );
    }
    expect(
      RpcSessionEvent.safeParse({ kind: "notification", frame: { type: "future_notification" } })
        .success,
    ).toBe(true);
    expect(RpcSessionEvent.safeParse({ kind: "notification", frame: {} }).success).toBe(false);
    expect(
      RpcSessionEvent.safeParse({ kind: "notification", frame: { type: "ready" } }).success,
    ).toBe(false);

    expect(RpcSessionEvent.safeParse({ kind: "unknown", event: {} }).success).toBe(false);
    expect(
      RpcSessionEvent.safeParse({
        kind: "prompt_result",
        event: { type: "prompt_result", status: "completed", sessionSettled: false },
      }).success,
    ).toBe(false);
  });

  test("validates request answers, subscriptions and the per-thread event stream", () => {
    expect(
      RpcSessionPort.methods.answerExtensionUi.args.safeParse({
        threadId,
        response: { type: "extension_ui_response", id: "ui-1", confirmed: true },
      }).success,
    ).toBe(true);
    expect(
      RpcSessionPort.methods.answerExtensionUi.args.safeParse({
        threadId,
        response: { type: "extension_ui_response", id: "", confirmed: true },
      }).success,
    ).toBe(false);
    expect(
      RpcSessionPort.methods.answerHostTool.args.safeParse({
        threadId,
        response: {
          type: "host_tool_result",
          id: "host-1",
          result: { content: [] },
        },
      }).success,
    ).toBe(true);
    expect(
      RpcSessionPort.methods.answerHostUri.args.safeParse({
        threadId,
        response: { type: "host_uri_result", id: "uri-1", isError: true, error: "denied" },
      }).success,
    ).toBe(true);
    expect(
      RpcSessionPort.methods.answerHostUri.args.safeParse({
        threadId,
        response: { type: "host_uri_result", id: "" },
      }).success,
    ).toBe(false);

    expect(SetSubagentSubscriptionArgs.safeParse({ threadId, level: "events" }).success).toBe(true);
    expect(SetSubagentSubscriptionArgs.safeParse({ threadId, level: "verbose" }).success).toBe(
      false,
    );
    expect(
      SetEventFilterArgs.safeParse({ threadId, events: null, messageUpdates: "delta" }).success,
    ).toBe(true);
    expect(SetEventFilterArgs.safeParse({ threadId, events: ["turn_start"] }).success).toBe(true);
    expect(SetEventFilterArgs.safeParse({ threadId, events: [] }).success).toBe(true);
    expect(SetEventFilterArgs.safeParse({ threadId, events: [""] }).success).toBe(false);

    const stream = rpcSessionEventStream(threadId);
    expect(stream).toBe(`A0.rpcSession/event/${threadId}`);
    expect(SubscribeResult.safeParse({ stream }).success).toBe(true);
    expect(SubscribeResult.safeParse({}).success).toBe(false);
    expect(RpcSessionPort.methods.restart.args.safeParse({ threadId }).success).toBe(true);
    expect(RpcSessionPort.methods.restart.args.safeParse({}).success).toBe(false);
  });

  test("reads the questions a chat's omp is still waiting on, and only those", () => {
    const parses = (value: unknown) =>
      RpcSessionPort.methods.openQuestions.result.safeParse(value).success;
    const confirm = {
      type: "extension_ui_request",
      id: "ui-1",
      method: "confirm",
      title: "Go on?",
      message: "",
    };
    expect(parses([{ seq: 4, request: confirm }])).toBe(true);
    expect(parses([{ seq: 0, request: confirm }])).toBe(false);
    expect(
      parses([{ seq: 4, request: { ...confirm, method: "notify", message: "heads up" } }]),
    ).toBe(false);
    expect(
      parses([
        {
          seq: 4,
          request: {
            type: "extension_ui_request",
            id: "cancel-1",
            method: "cancel",
            targetId: "ui-1",
          },
        },
      ]),
    ).toBe(false);
  });

  test("reads the state a chat's omp holds: its statuses, widgets and title, and nothing else", () => {
    const parses = (value: unknown) =>
      RpcSessionPort.methods.stateFrames.result.safeParse(value).success;
    const status = {
      type: "extension_ui_request",
      id: "status-1",
      method: "setStatus",
      statusKey: "build",
      statusText: "Running",
    };
    const title = {
      type: "extension_ui_request",
      id: "title-1",
      method: "setTitle",
      title: "Build status",
    };
    expect(
      parses([
        { seq: 4, request: status },
        { seq: 5, request: title },
      ]),
    ).toBe(true);
    expect(parses([{ seq: 0, request: status }])).toBe(false);
    expect(
      parses([{ seq: 4, request: { ...status, method: "notify", message: "heads up" } }]),
    ).toBe(false);
    expect(
      parses([{ seq: 4, request: { ...status, method: "confirm", title: "Go on?", message: "" } }]),
    ).toBe(false);
  });

  test("exposes command capabilities and a correlated typed send", async () => {
    expect(ompCommandCapability("prompt")).toBe("omp.cmd.prompt");
    expect(RpcSessionPort.methods.answerExtensionUi.capability).toBe("omp.ui");
    expect(RpcSessionPort.methods.answerHostTool.capability).toBe("omp.host-tools");
    expect(RpcSessionPort.methods.answerHostUri.capability).toBe("omp.host-uris");

    const send: RpcSessionSend = async <K extends OmpCommandName>(
      args: TypedSendCommandArgs<K>,
    ): Promise<OmpCommandMap[K]["result"]> => {
      RpcSessionPort.methods.send.args.parse(args);
      return undefined as OmpCommandMap[K]["result"];
    };
    const result = await send({ threadId, command: { type: "get_state" } });
    const typedResult: OmpCommandMap["get_state"]["result"] = result;
    expect(typedResult).toBeUndefined();
  });
});

describe("AppPort", () => {
  test("validates server info, capability maps and health", () => {
    expect(AppPort.methods.serverInfo.args.safeParse({}).success).toBe(true);
    expect(
      AppPort.methods.serverInfo.result.safeParse({
        instanceId: "instance-1",
        serverVersion: "0.1.0",
        launchFolder: "/workspace",
        omp: { version: "18.6.1", protocolVersion: 2 },
      }).success,
    ).toBe(true);
    expect(
      AppServerInfo.safeParse({
        instanceId: "",
        serverVersion: "0.1.0",
        omp: null,
      }).success,
    ).toBe(false);
    expect(AppPort.methods.capabilities.result.safeParse({}).success).toBe(true);
    expect(AppPort.methods.health.result.safeParse({ status: "ok" }).success).toBe(true);
    expect(AppHealth.safeParse({ status: "broken" }).success).toBe(false);
    expect(AppPort.methods.health.args.safeParse({ unexpected: true }).success).toBe(false);
  });
});
