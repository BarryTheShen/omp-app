import type { HostCallId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  cancelledHostToolResult,
  cancelledHostUriResult,
  HostRequestAnswerSchema,
} from "./host-answers";

const requestId = "host-1" as HostCallId;

describe("HostRequestAnswerSchema", () => {
  test("accepts a representative value for each of the three kinds", () => {
    expect(
      HostRequestAnswerSchema.safeParse({
        kind: "tool-update",
        requestId,
        partialResult: { content: [{ type: "text", text: "working…" }] },
      }).success,
    ).toBe(true);
    expect(
      HostRequestAnswerSchema.safeParse({
        kind: "tool-result",
        requestId,
        result: { content: [{ type: "text", text: "done" }], isError: false },
      }).success,
    ).toBe(true);
    expect(
      HostRequestAnswerSchema.safeParse({
        kind: "uri-result",
        requestId,
        result: { content: "# Title", contentType: "text/markdown" },
      }).success,
    ).toBe(true);
  });

  test("rejects a tool payload missing content, and an unknown kind", () => {
    expect(
      HostRequestAnswerSchema.safeParse({
        kind: "tool-result",
        requestId,
        result: { isError: true },
      }).success,
    ).toBe(false);
    expect(
      HostRequestAnswerSchema.safeParse({
        kind: "tool-error",
        requestId,
        result: { content: [] },
      }).success,
    ).toBe(false);
  });
});

describe("cancelledHostToolResult", () => {
  test("builds an error-shaped tool result carrying the reason as text", () => {
    expect(cancelledHostToolResult(requestId, "Dismissed by the user.")).toEqual({
      kind: "tool-result",
      requestId,
      result: { content: [{ type: "text", text: "Dismissed by the user." }], isError: true },
    });
  });
});

describe("cancelledHostUriResult", () => {
  test("builds an error-shaped URI result carrying the reason", () => {
    expect(cancelledHostUriResult(requestId, "Thread switched before the read finished.")).toEqual({
      kind: "uri-result",
      requestId,
      result: { isError: true, error: "Thread switched before the read finished." },
    });
  });
});
