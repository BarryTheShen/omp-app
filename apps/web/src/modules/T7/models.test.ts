import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  capabilityForT7Tool,
  decodeCheckpoint,
  decodeGoal,
  decodeHostTool,
  decodeHostUri,
  decodeResolve,
  decodeRewind,
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
    [decodeGoal, { op: "create", objective: "ship", tokenBudget: 100 }],
    [decodeSecurityScan, { action: "status", operation: "preflight" }],
    [decodeThink, { recorded: true }],
  ])("decodes %s details without executing", (decode, raw) => {
    expect(decode(raw)).toMatchObject({ ok: true, raw });
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
