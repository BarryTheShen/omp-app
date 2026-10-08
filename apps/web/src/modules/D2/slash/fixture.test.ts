import { describe, expect, test } from "vitest";
import { SlashCommand } from "../contract";
import { REAL_COMMAND_LIST, REAL_COMMAND_OUTPUTS } from "./test-support";

describe("D2.3 fixtures captured from real omp", () => {
  test("every command omp listed matches the D2.1 slash command schema", () => {
    expect(REAL_COMMAND_LIST).toHaveLength(50);
    for (const raw of REAL_COMMAND_LIST) {
      expect(SlashCommand.safeParse(raw).success, JSON.stringify(raw)).toBe(true);
    }
  });

  test("the captured outputs came from commands that finished without a model turn", () => {
    expect(REAL_COMMAND_OUTPUTS.length).toBeGreaterThan(0);
    for (const entry of REAL_COMMAND_OUTPUTS) {
      expect(entry.response.data.agentInvoked, entry.command).toBe(false);
    }
  });
});
