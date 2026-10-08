import { describe, expect, test } from "vitest";
import { describeCommandResult, plainOutputText } from "./output";
import { completedRun, REAL_COMMAND_OUTPUTS } from "./test-support";

function capturedText(command: string): string {
  const entry = REAL_COMMAND_OUTPUTS.find((item) => item.command === command);
  return entry?.texts[0] ?? "";
}

describe("D2.3 command output", () => {
  test("real /context output keeps omp's words and loses every escape sequence", () => {
    const raw = capturedText("/context");
    expect(raw).toContain("\u001b[");
    const plain = plainOutputText(raw);
    expect(plain).not.toContain("\u001b");
    expect(plain.startsWith("Context window: 128000 tokens")).toBe(true);
  });

  test("control characters go, while line breaks and tabs stay", () => {
    expect(plainOutputText("\u001b[1mBold\u001b[22m done\r\n\tnext\u0007")).toBe(
      "Bold done\n\tnext",
    );
  });

  test("a finished command reads as one plain line of omp's text", () => {
    const result = completedRun("/usage", capturedText("/usage"));
    const line = describeCommandResult(result, "/usage");
    expect(line.startsWith("omp: Usage Input tokens: 0")).toBe(true);
    expect(line).not.toContain("\n");
  });

  test("a command that printed nothing says that it ran", () => {
    expect(describeCommandResult(completedRun("/x", ""), "/x")).toBe("Ran /x.");
  });
});
