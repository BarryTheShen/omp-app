import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  decodeComputerArgs,
  decodeDebugArgs,
  decodeEvalArgs,
  decodeInspectImageArgs,
  mapT3Failure,
  normalizeComputer,
  normalizeDebug,
  normalizeEval,
  normalizeInspectImage,
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

  test("accepts debug action snapshots and tolerant computer results", () => {
    expect(decodeDebugArgs({ action: "launch", program: "node" }).ok).toBe(true);
    expect(decodeComputerArgs({ action: "run", code: "return 1", read_only: true }).ok).toBe(true);
    expect(
      normalizeDebug(
        { action: "launch" },
        { details: { status: "stopped", stackFrames: [{ id: 1 }] } },
      ),
    ).toMatchObject({ details: { status: "stopped" } });
    expect(
      normalizeComputer(
        { action: "capabilities" },
        { details: { backend: "computer", permissions: { input: false } } },
      ),
    ).toMatchObject({ details: { permissions: { input: false } } });
  });

  test("accepts inspect-image analysis and preserves safe bounded preview", () => {
    expect(decodeInspectImageArgs({ path: "image.png", mode: "describe" }).ok).toBe(true);
    expect(
      normalizeInspectImage(
        { path: "image.png" },
        {
          content: [{ type: "text", text: "A diagram" }],
          details: { description: "A diagram", status: "complete" },
        },
      ),
    ).toMatchObject({ details: { description: "A diagram" }, preview: "A diagram" });
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
