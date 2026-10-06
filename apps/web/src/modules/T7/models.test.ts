import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  capabilityForT7Tool,
  decodeCheckpoint,
  decodeCheckpointArgs,
  decodeGoal,
  decodeHostTool,
  decodeHostUri,
  decodeResolve,
  decodeRewind,
  decodeRewindArgs,
  decodeSecurityScan,
  decodeThink,
  safeToolError,
  unavailableForT7Tool,
} from "./models";

describe("T7 tolerant domain models", () => {
  test.each([
    [decodeHostTool, { status: "running", toolCallId: "host-1" }],
    [decodeHostUri, { operation: "read", url: "skill://demo", status: "pending" }],
    [decodeResolve, { action: "apply", reason: "approved" }],
    [decodeCheckpoint, { goal: "before migration" }],
    [decodeRewind, { report: "recorded only", rewound: false }],
    [decodeGoal, { op: "create", goal: { objective: "ship", tokenBudget: 100, tokensUsed: 0 } }],
    [decodeSecurityScan, { action: "status", operation: { scanId: "scan-1", phase: "reviewing" } }],
    [decodeThink, { recorded: true }],
  ])("decodes %s details without executing", (decode, raw) => {
    expect(decode(raw)).toMatchObject({ ok: true, raw });
  });

  test("decodes omp v18.6.1 checkpoint and rewind arguments and details", () => {
    // omp packages/coding-agent/src/tools/checkpoint.ts:29-37 (args) and :41-51,83,127 (details).
    expect(decodeCheckpointArgs({ goal: "find the cache bug" }).ok).toBe(true);
    expect(decodeCheckpointArgs({}).ok).toBe(false);
    expect(decodeRewindArgs({ report: "Found it." }).ok).toBe(true);
    expect(
      decodeCheckpoint({ goal: "find the cache bug", startedAt: "2026-10-05T12:00:00.000Z" }).ok,
    ).toBe(true);
    expect(decodeRewind({ report: "Found it.", rewound: true }).ok).toBe(true);
    expect(decodeRewind({ report: 4 }).ok).toBe(false);
  });

  test("decodes omp v18.6.1 goal details with a nested goal and null fields", () => {
    const complete = {
      op: "complete",
      goal: {
        id: "goal-1",
        objective: "Ship the release notes",
        status: "complete",
        tokenBudget: 50_000,
        tokensUsed: 41_250,
        timeUsedSeconds: 600,
        createdAt: 1,
        updatedAt: 2,
      },
      remainingTokens: 8_750,
      completionBudgetReport:
        "Goal achieved. Report final budget usage to the user: tokens used: 41250 of 50000.",
    };
    expect(decodeGoal(complete)).toMatchObject({
      ok: true,
      value: {
        goal: { objective: "Ship the release notes", status: "complete", tokensUsed: 41_250 },
        remainingTokens: 8_750,
      },
    });
    expect(
      decodeGoal({ op: "get", goal: null, remainingTokens: null, completionBudgetReport: null }),
    ).toMatchObject({ ok: true, value: { goal: null, remainingTokens: null } });
    expect(decodeGoal({ op: "get", goal: { status: "finished" } })).toMatchObject({ ok: false });
  });

  test("decodes omp v18.6.1 security_scan details with an operation snapshot and cloud stats", () => {
    const status = {
      action: "status",
      operation: {
        operationId: "op-1",
        planId: "plan-1",
        scanId: "scan-1",
        phase: "completed",
        createdAt: "2026-10-05T10:00:00Z",
        updatedAt: "2026-10-05T10:05:00Z",
        findingCount: 3,
      },
    };
    expect(decodeSecurityScan(status)).toMatchObject({
      ok: true,
      value: { operation: { phase: "completed", findingCount: 3 } },
    });
    const cloud = {
      action: "cloud_status",
      cloudStats: {
        configurationId: "cfg-1",
        currentStep: "scanning",
        pendingCommits: 2,
        finishedCommits: 10,
        failedCommits: 0,
        findingCounts: { critical: 1, high: 0, medium: 4, low: 2, informational: 0 },
      },
    };
    expect(decodeSecurityScan(cloud)).toMatchObject({
      ok: true,
      value: { cloudStats: { findingCounts: { critical: 1, medium: 4 } } },
    });
    expect(decodeSecurityScan({ action: "status", operation: "preflight" })).toMatchObject({
      ok: false,
    });
  });

  test("keeps unknown details raw and maps malformed data to a safe AppFailure", () => {
    const malformed = decodeHostTool({ status: "unknown-status" });
    expect(malformed).toMatchObject({ ok: false, error: { appError: { code: "invalid_args" } } });
    expect(unavailableForT7Tool("host_tool")).toMatchObject({
      appError: { code: "unavailable", capability: "omp.host-tools" },
    });
    expect(capabilityForT7Tool("unknown")).toBeUndefined();
    expect(
      safeToolError(
        new AppFailure({ code: "permission", message: "secret/path", retryable: false }),
      ),
    ).toEqual({
      code: "permission",
      message: "The tool reported an error.",
      retryable: false,
    });
  });
});
