import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  decodeComputerArgs,
  decodeDebugArgs,
  decodeDebugDetails,
  decodeEvalArgs,
  mapT3Failure,
  normalizeComputer,
  normalizeEval,
} from "./models";

describe("T3 tolerant execution models", () => {
  test("accepts eval cells, async jobs, images and output metadata", () => {
    expect(decodeEvalArgs({ language: "py", code: "print(1)", timeout: 20 }).ok).toBe(true);
    expect(
      normalizeEval(
        { language: "py", code: "print(1)" },
        {
          content: [{ type: "text", text: "1" }],
          details: {
            cells: [{ index: 0, code: "print(1)", language: "py", status: "complete" }],
            async: { state: "completed", jobId: "job-1", type: "eval" },
            meta: { truncation: { direction: "tail", reason: "lines" } },
          },
        },
      ),
    ).toMatchObject({
      details: { cells: [{ status: "complete" }] },
      outputMeta: { truncation: expect.any(Object) },
    });
  });

  test("accepts omp v18.6.1's real debug details and tolerant computer results", () => {
    expect(decodeDebugArgs({ action: "launch", program: "node" }).ok).toBe(true);
    expect(decodeComputerArgs({ action: "run", code: "return 1", read_only: true }).ok).toBe(true);
    // DebugExecutionDetails: omp packages/coding-agent/src/tools/debug.ts:143-171.
    const debug = decodeDebugDetails({
      action: "stack_trace",
      success: true,
      snapshot: {
        id: "session-1",
        adapter: "debugpy",
        cwd: "/repo",
        status: "stopped",
        launchedAt: "2026-10-05T12:00:00Z",
        lastUsedAt: "2026-10-05T12:00:01Z",
        stopReason: "breakpoint",
        source: { path: "src/main.py" },
        line: 42,
        breakpointFiles: 1,
        breakpointCount: 1,
        functionBreakpointCount: 0,
        outputBytes: 0,
        outputTruncated: false,
        needsConfigurationDone: false,
      },
      stackFrames: [{ id: 1, name: "main", source: { path: "src/main.py" }, line: 42, column: 5 }],
    });
    expect(debug.ok && debug.value?.snapshot?.source?.path).toBe("src/main.py");
    expect(debug.ok && debug.value?.stackFrames?.[0]?.line).toBe(42);
    expect(decodeDebugDetails({ stackFrames: [{ file: "src/main.py" }] }).ok).toBe(false);
    expect(
      normalizeComputer(
        { action: "capabilities" },
        { details: { backend: "computer", permissions: { input: false } } },
      ),
    ).toMatchObject({ details: { permissions: { input: false } } });
  });

  test("malformed details remain raw and become a visible malformed model", () => {
    const model = normalizeEval(
      { language: "py" },
      { content: [{ text: "partial" }], details: "not an object" },
    );
    expect(model.malformed).toBe(true);
    expect(model.raw).toEqual({ content: [{ text: "partial" }], details: "not an object" });
  });

  test("maps failures without echoing private execution data", () => {
    const failure = new AppFailure({ code: "permission", message: "blocked", retryable: false });
    expect(mapT3Failure(failure, "computer")).toBe(failure);
    expect(mapT3Failure(new Error("secret local path"), "debug").appError.message).not.toContain(
      "secret local path",
    );
  });
});
