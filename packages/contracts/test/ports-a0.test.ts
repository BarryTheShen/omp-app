import { describe, expect, test } from "bun:test";
import { FolderPath, ThreadId } from "../src";
import {
  AppHealth,
  AppPort,
  AppServerInfo,
  ChatSessionPort,
  chatSessionEventStream,
  OpenThreadArgs,
  SetSubagentSubscriptionArgs,
  SubscribeResult,
} from "../src/ports/A0";

describe("ChatSessionPort's arguments", () => {
  const threadId = ThreadId.parse("thread-1");
  const folderPath = FolderPath.parse("/workspace/project");

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
  });

  test("validates subscriptions, restarts and the per-thread event stream", () => {
    expect(SetSubagentSubscriptionArgs.safeParse({ threadId, level: "events" }).success).toBe(true);
    expect(SetSubagentSubscriptionArgs.safeParse({ threadId, level: "verbose" }).success).toBe(
      false,
    );
    expect(SubscribeResult.safeParse({ stream: chatSessionEventStream(threadId) }).success).toBe(
      true,
    );
    expect(SubscribeResult.safeParse({}).success).toBe(false);
    expect(ChatSessionPort.methods.restart.args.safeParse({ threadId }).success).toBe(true);
    expect(ChatSessionPort.methods.restart.args.safeParse({}).success).toBe(false);
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
    expect(
      AppPort.methods.reportClientTrace.args.safeParse({
        marks: { click: 12.5, composer_typable: 23 },
        gaps: [54.2],
        supported: ["layout-shift"],
      }).success,
    ).toBe(true);
    expect(
      AppPort.methods.reportClientTrace.args.safeParse({
        marks: { "chat text": 12 },
        gaps: [],
        supported: [],
      }).success,
    ).toBe(false);
    expect(AppHealth.safeParse({ status: "broken" }).success).toBe(false);
    expect(AppPort.methods.health.args.safeParse({ unexpected: true }).success).toBe(false);
  });
});
