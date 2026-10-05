import { AppFailure, type CapabilityMap, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { T5_TOOL_DESCRIPTORS } from "./descriptor";
import {
  decodeHubDetails,
  decodeTaskDetails,
  decodeToolFailure,
  decodeVibeDetails,
  decodeWaitDetails,
  decodeYieldDetails,
  hasT5Capability,
  T5CapabilityKeys,
  TaskToolArgsSchema,
  toT5AppFailure,
  VibeKillArgsSchema,
  VibeListArgsSchema,
  VibeSendArgsSchema,
  VibeSpawnArgsSchema,
  VibeWaitArgsSchema,
} from "./models";

describe("T5 agent and coordination models", () => {
  test("accepts every tool's released shape and preserves unknown detail fields", () => {
    expect(decodeHubDetails({ op: "jobs", jobs: [], futureHubField: { raw: true } })).toMatchObject(
      {
        ok: true,
        value: { futureHubField: { raw: true } },
      },
    );
    expect(
      decodeTaskDetails({
        status: "running",
        parentTaskId: "parent-task",
        depth: 2,
        progress: { percent: 40, currentTool: "read" },
        futureTaskField: "raw",
      }),
    ).toMatchObject({ ok: true, value: { futureTaskField: "raw" } });
    expect(
      decodeTaskDetails({
        lifecycle: { status: "started", index: 0 },
        events: [{ type: "subagent_progress", payload: { percent: 35 } }],
        transcript: { depth: 1, messages: [], fromByte: 0, nextByte: 12 },
      }),
    ).toMatchObject({ ok: true });
    expect(
      decodeHubDetails({
        op: "send",
        messages: [{ from: "agent-a", to: "agent-b", text: "ready" }],
        receipts: [{ accepted: true, delivered: true }],
      }),
    ).toMatchObject({ ok: true });
    expect(
      decodeVibeDetails({
        op: "wait",
        wait: { settled: ["session-a"], stillRunning: ["session-b"], timedOut: true },
        futureVibeField: ["raw"],
      }),
    ).toMatchObject({ ok: true, value: { futureVibeField: ["raw"] } });
    expect(
      decodeYieldDetails({ status: "aborted", data: { section: 1 }, futureYieldField: 7 }),
    ).toMatchObject({
      ok: true,
      value: { futureYieldField: 7 },
    });
    expect(
      decodeWaitDetails({
        op: "wait",
        jobs: [{ id: "job-1", status: "running" }],
        sealed: true,
        futureWaitField: false,
      }),
    ).toMatchObject({ ok: true, value: { futureWaitField: false } });
  });

  test("validates task and vibe argument shapes without client execution", () => {
    expect(TaskToolArgsSchema.safeParse({ prompt: "inspect", future: true }).success).toBe(true);
    expect(
      VibeSpawnArgsSchema.safeParse({ cli: "fast", prompt: "inspect", name: "worker-a" }).success,
    ).toBe(true);
    expect(VibeSendArgsSchema.safeParse({ session: "worker-a", message: "status?" }).success).toBe(
      true,
    );
    expect(VibeWaitArgsSchema.safeParse({ sessions: ["worker-a"], timeout: 500 }).success).toBe(
      true,
    );
    expect(VibeKillArgsSchema.safeParse({ session: "worker-a" }).success).toBe(true);
    expect(VibeListArgsSchema.safeParse({}).success).toBe(true);
    expect(VibeSpawnArgsSchema.safeParse({ cli: "unknown", prompt: "inspect" }).success).toBe(
      false,
    );
  });

  test("turns malformed details into typed fallback failures and maps timeout/cancel", () => {
    for (const result of [
      decodeHubDetails(null),
      decodeTaskDetails({ progress: { percent: 101 } }),
      decodeVibeDetails({ wait: { timedOut: "yes" } }),
      decodeYieldDetails({ status: "unknown" }),
      decodeWaitDetails({ jobs: [{ status: "unknown" }] }),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AppFailure);
        expect(result.error.appError.code).toBe("invalid_args");
        expect(result.raw).toBeDefined();
      }
    }

    expect(toT5AppFailure({ timedOut: true }).appError).toMatchObject({ code: "timeout" });
    expect(toT5AppFailure({ cancelled: true }).appError).toMatchObject({ code: "cancelled" });
    expect(decodeToolFailure({ code: "unavailable", capability: "omp.subagent-events" }).ok).toBe(
      true,
    );
  });

  test("keeps cards visible while gating only live capabilities", () => {
    const capabilities: CapabilityMap = {
      [T5CapabilityKeys.subagentEvents]: { state: "available", via: "rpc" },
      [T5CapabilityKeys.commandGateway]: { state: "unavailable", via: "host" },
    };
    expect(hasT5Capability(capabilities, T5CapabilityKeys.subagentEvents)).toBe(true);
    expect(hasT5Capability(capabilities, T5CapabilityKeys.commandGateway)).toBe(false);
  });
});

describe("T5 descriptors", () => {
  test("claims the nine T5 rows and the single P1 task row", () => {
    expect(validateRegistry(T5_TOOL_DESCRIPTORS)).toEqual([]);
    expect(T5_TOOL_DESCRIPTORS).toHaveLength(9);
    expect(T5_TOOL_DESCRIPTORS.flatMap((descriptor) => descriptor.covers)).toEqual([
      "T5.hub",
      "T5.task",
      "P1.task-subagent-card",
      "T5.vibe-kill",
      "T5.vibe-list",
      "T5.vibe-send",
      "T5.vibe-spawn",
      "T5.vibe-wait",
      "T5.yield",
      "T5.wait",
    ]);
    expect(T5_TOOL_DESCRIPTORS.find((descriptor) => descriptor.id === "T5.task")?.match).toEqual({
      by: "name",
      name: "task",
    });
  });
});
