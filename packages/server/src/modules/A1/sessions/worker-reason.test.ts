import { describe, expect, test } from "bun:test";
import { workerFailureReason } from "./worker-reason";

/*
 * omp's failure text for a provider 400 it saved: the provider's message, the provider's body (the message again,
 * with the type added), and the saved request's path (pi-ai 18.6.1 src/utils/http-inspector.ts:103). The path is the
 * one line the reason must not keep.
 */
const SAVED = "/example/omp-home/logs/http-400-requests/request.json";
const PROVIDER_TEXT = [
  "400 fake provider failure for the failing subagent",
  "fake provider failure for the failing subagent (type=invalid_request_error)",
  `raw-http-request=${SAVED}`,
].join("\n");
const REASON = "400 fake provider failure for the failing subagent (type=invalid_request_error)";

describe("workerFailureReason", () => {
  test("keeps the provider's words once and drops the saved request's path", () => {
    expect(workerFailureReason(PROVIDER_TEXT)).toBe(REASON);
    expect(workerFailureReason(PROVIDER_TEXT)).not.toContain("raw-http-request");
    expect(workerFailureReason(PROVIDER_TEXT)).not.toContain(SAVED);
  });

  test("drops the line omp writes when the save failed (pi-ai 18.6.1 src/utils/http-inspector.ts:106)", () => {
    expect(
      workerFailureReason("400 bad block\nraw-http-request-save-failed=EACCES: permission denied"),
    ).toBe("400 bad block");
  });

  test("a message with no repeat and no diagnostics is kept as it is", () => {
    expect(workerFailureReason("404 model not found")).toBe("404 model not found");
  });

  test("two lines that say different things are both kept, joined with a space", () => {
    expect(workerFailureReason("400 bad block\nmessages.0 has no content")).toBe(
      "400 bad block messages.0 has no content",
    );
  });

  test("no text, or only omp's diagnostics, gives no reason", () => {
    expect(workerFailureReason(undefined)).toBeUndefined();
    expect(workerFailureReason("")).toBeUndefined();
    expect(workerFailureReason(`raw-http-request=${SAVED}`)).toBeUndefined();
  });
});
