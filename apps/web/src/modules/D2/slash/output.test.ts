import { describe, expect, test } from "vitest";
import { commandOutputView, plainOutputText } from "./output";
import { REAL_COMMAND_OUTPUTS } from "./test-support";

/** The texts real omp printed for a command, captured through RPC (fixtures/real-command-outputs.json). */
function capturedTexts(command: string): readonly string[] {
  return REAL_COMMAND_OUTPUTS.find((item) => item.command === command)?.texts ?? [];
}

describe("D2.3 command output", () => {
  test("real /context output keeps omp's words and loses every escape sequence", () => {
    const raw = capturedTexts("/context")[0] ?? "";
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

  test("real /usage output is a report: every line stays, in order", () => {
    expect(commandOutputView(capturedTexts("/usage"), "/usage")).toEqual({
      kind: "report",
      text: [
        "Usage",
        "Input tokens: 0",
        "Output tokens: 0",
        "Cache read tokens: 0",
        "Cache write tokens: 0",
        "Total tokens: 0",
        "Premium requests: 0",
        "Cost: $0.000000",
      ].join("\n"),
    });
  });

  test("real /context output is a report with its escape sequences gone and all six lines kept", () => {
    const view = commandOutputView(capturedTexts("/context"), "/context");
    expect(view.kind).toBe("report");
    const lines = view.text.split("\n");
    expect(view.text).not.toContain("\u001b");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("Context window: 128000 tokens (5% used)");
    expect(lines[5]).toContain("Free");
    expect(lines[5]).toContain("102098 tokens");
  });

  test("one line of omp's text is the header's line, with its spaces collapsed", () => {
    expect(commandOutputView(["Enabled   X\n"], "/x")).toEqual({
      kind: "header",
      text: "omp: Enabled X",
    });
  });

  test("a line break inside one reply makes a report, and the line break is kept", () => {
    expect(commandOutputView(["Usage\nTotal tokens: 0"], "/usage")).toEqual({
      kind: "report",
      text: "Usage\nTotal tokens: 0",
    });
  });

  test("replies printed one line each make one report, in the order omp printed them", () => {
    expect(commandOutputView(["Compacting…", "", "Done."], "/compact")).toEqual({
      kind: "report",
      text: "Compacting…\nDone.",
    });
  });

  test("a command that printed nothing says that it ran", () => {
    expect(commandOutputView([], "/x")).toEqual({ kind: "header", text: "Ran /x." });
    expect(commandOutputView(["", " \n "], "/x")).toEqual({ kind: "header", text: "Ran /x." });
  });
});
