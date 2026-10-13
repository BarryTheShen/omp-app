import { checkScrubbed } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { SlashCommand } from "../contract";
import { RECORDED_COMMANDS, recordedCommandsFrom } from "../fixtures/captures";

describe("the recorded get_available_commands capture", () => {
  test("holds the 52 commands omp listed, and every one matches the D2.1 slash command schema", () => {
    expect(RECORDED_COMMANDS).toHaveLength(52);
    for (const raw of RECORDED_COMMANDS) {
      expect(SlashCommand.safeParse(raw).success, JSON.stringify(raw)).toBe(true);
    }
  });

  test("holds each command source omp listed, with the counts of the recording", () => {
    expect(recordedCommandsFrom("builtin")).toHaveLength(45);
    expect(recordedCommandsFrom("skill")).toHaveLength(1);
    expect(recordedCommandsFrom("extension")).toHaveLength(1);
    expect(recordedCommandsFrom("custom")).toHaveLength(3);
    expect(recordedCommandsFrom("mcp_prompt")).toHaveLength(1);
    expect(recordedCommandsFrom("file")).toHaveLength(1);
  });

  test("the skill and the MCP prompt carry the names omp gives them", () => {
    const names = (source: "skill" | "mcp_prompt") =>
      recordedCommandsFrom(source).map((entry) => (entry as { name: string }).name);
    expect(names("skill")).toEqual(["skill:typo-check"]);
    expect(names("mcp_prompt")).toEqual(["d2-recording:summarize"]);
  });

  test("the capture holds no private path and no key (C0's scrub check)", () => {
    expect(checkScrubbed(JSON.stringify(RECORDED_COMMANDS))).toEqual([]);
  });
});
