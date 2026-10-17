import { CommandDescriptor } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  DESTRUCTIVE_MEMORY_COMMANDS,
  MEMORY_COMMAND_DESCRIPTORS,
  MEMORY_COMMANDS,
  normalizeMemoryCommand,
  requiresMemoryCommandExecutor,
} from "../../memory/commands";

describe("memory command descriptors", () => {
  test("exports a contracts descriptor for omp's memory command", () => {
    expect(MEMORY_COMMAND_DESCRIPTORS).toHaveLength(15);
    expect(CommandDescriptor.parse(MEMORY_COMMAND_DESCRIPTORS[0])).toEqual(
      MEMORY_COMMAND_DESCRIPTORS[0],
    );
    expect(MEMORY_COMMAND_DESCRIPTORS[0]).toMatchObject({
      id: "I3.memory",
      owner: "I3",
      covers: ["C4.memory"],
      slash: { name: "memory", source: "builtin" },
    });
    expect(MEMORY_COMMAND_DESCRIPTORS.at(-1)).toMatchObject({ covers: ["C4.memory-view"] });
  });

  test("lists available controls once and omits unsupported mental-model deletion", () => {
    expect(new Set(MEMORY_COMMANDS).size).toBe(MEMORY_COMMANDS.length);
    expect(MEMORY_COMMANDS).toContain("view");
    expect(MEMORY_COMMANDS).toContain("rebuild");
    expect(MEMORY_COMMANDS).toContain("mm-reload");
    expect(MEMORY_COMMANDS).not.toContain("mm-delete");
    expect(DESTRUCTIVE_MEMORY_COMMANDS.has("clear")).toBe(true);
    expect(DESTRUCTIVE_MEMORY_COMMANDS.has("rebuild")).toBe(false);
    expect(DESTRUCTIVE_MEMORY_COMMANDS.has("mm-seed")).toBe(true);
    expect(DESTRUCTIVE_MEMORY_COMMANDS.has("view")).toBe(false);
  });

  test("normalizes omp aliases and gates actions without typed A1 support", () => {
    expect(normalizeMemoryCommand("rebuild")).toBe("enqueue");
    expect(normalizeMemoryCommand("reset")).toBe("clear");
    expect(normalizeMemoryCommand("mm-list")).toBe("mm-list");
    expect(requiresMemoryCommandExecutor("stats")).toBe(true);
    expect(requiresMemoryCommandExecutor("rebuild")).toBe(true);
  });
});
