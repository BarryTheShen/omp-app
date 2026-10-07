import { AppFailure, type CapabilityMap, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { T5_TOOL_DESCRIPTORS } from "./descriptor";
import { T5_REAL_RESULTS } from "./fixtures/real-results";
import {
  decodeHubDetails,
  decodeTaskDetails,
  decodeToolFailure,
  decodeVibeDetails,
  decodeWaitDetails,
  decodeYieldDetails,
  hasT5Capability,
  T5CapabilityKeys,
  toT5AppFailure,
  VibeKillArgsSchema,
  VibeListArgsSchema,
  VibeSendArgsSchema,
  VibeSpawnArgsSchema,
  VibeWaitArgsSchema,
} from "./models";
import { alteredDetails, sampleNamed } from "./recorded-props";

/** Whether a recorded result's details decode with the schema of the tool that produced them. */
function decodesAs(toolName: string, details: unknown): boolean {
  if (toolName === "wait") return decodeWaitDetails(details).ok;
  if (toolName === "hub") return decodeHubDetails(details).ok;
  if (toolName === "task") return decodeTaskDetails(details).ok;
  throw new Error(`No T5 decoder for ${toolName}`);
}

describe("T5 coordination and task details", () => {
  test("every recorded wait, hub and task result decodes with its own schema", () => {
    for (const sample of T5_REAL_RESULTS) {
      expect(decodesAs(sample.toolName, sample.result.details), sample.name).toBe(true);
    }
  });

  test("a launch service's log decodes: the logs op is a hub op, not a coordination op", () => {
    expect(
      decodeHubDetails(sampleNamed("hub: the log of a service that is ready").result.details),
    ).toMatchObject({ ok: true, value: { op: "logs", state: "ready", cursor: 17608 } });
  });

  test("keeps fields omp adds later, raw", () => {
    const details = Object.assign(
      {},
      sampleNamed("wait: a message from another agent").result.details,
      {
        futureWaitField: { raw: true },
      },
    );
    expect(decodeWaitDetails(details)).toMatchObject({
      ok: true,
      value: { futureWaitField: { raw: true } },
    });
  });

  test("rejects values outside omp's wire types, so the card shows a visible error", () => {
    expect(
      decodeWaitDetails(
        alteredDetails("wait: a message from another agent", ["waited", "ts"], "now"),
      ).ok,
    ).toBe(false);
    expect(
      decodeHubDetails(
        alteredDetails("hub: a message delivered to one peer", ["receipts", 0, "outcome"], "lost"),
      ).ok,
    ).toBe(false);
    expect(
      decodeWaitDetails(
        alteredDetails(
          "wait: two running tasks and a finished command",
          ["jobs", 0, "status"],
          "paused",
        ),
      ).ok,
    ).toBe(false);
    expect(
      decodeHubDetails(
        alteredDetails("hub: a service that failed to start", ["daemon", "state"], "sleeping"),
      ).ok,
    ).toBe(false);
    expect(
      decodeTaskDetails(
        alteredDetails(
          "task: one agent started in the background",
          ["progress", 0, "status"],
          "paused",
        ),
      ).ok,
    ).toBe(false);
    expect(
      decodeTaskDetails(
        alteredDetails("task: one agent started in the background", ["async", "state"], "paused"),
      ).ok,
    ).toBe(false);
  });
});

describe("T5 vibe and yield models", () => {
  test("accepts vibe and yield details and keeps unknown fields", () => {
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
  });

  test("validates vibe argument shapes without client execution", () => {
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
