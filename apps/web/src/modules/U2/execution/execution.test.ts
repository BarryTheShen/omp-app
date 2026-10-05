import type { MessageKey, OmpMessage } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { normalizeExecutionMessage } from "./execution";

function runtimeMessage(message: unknown) {
  return {
    key: "entry:execution:1" as MessageKey,
    message: message as OmpMessage,
    status: "persisted" as const,
  };
}

describe("U2.6 execution normalization", () => {
  test("normalizes bash execution output with stable id and metadata", () => {
    expect(
      normalizeExecutionMessage(
        runtimeMessage({
          role: "bashExecution",
          command: "printf hello",
          output: "hello",
          cancelled: false,
          truncated: true,
          exitCode: 0,
          excludeFromContext: true,
        }),
      ),
    ).toEqual({
      id: "entry:execution:1",
      mode: "bash",
      source: "printf hello",
      output: "hello",
      cancelled: false,
      truncated: true,
      exitCode: 0,
      excludeFromContext: true,
    });
  });

  test("normalizes Python execution and ignores other message roles", () => {
    expect(
      normalizeExecutionMessage(
        runtimeMessage({
          role: "pythonExecution",
          code: "print(1)",
          output: "1",
          cancelled: true,
          truncated: false,
        }),
      ),
    ).toMatchObject({ mode: "python", source: "print(1)", cancelled: true });
    expect(
      normalizeExecutionMessage(
        runtimeMessage({ role: "assistant", content: [], stopReason: "stop" }),
      ),
    ).toBeUndefined();
  });
});
