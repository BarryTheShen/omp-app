import type { CommandDescriptor } from "@omp-app/contracts";
import { INVENTORY, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import catalog from "../../D2/slash/fixtures/real-get-available-commands.json";
import { D8_AP6_CAPABILITIES } from "../contract";
import { D8_OWNED_ROWS } from "../test/owned-rows";
import { D8_COMMAND_DESCRIPTORS, D8_DESCRIPTORS } from ".";

const requiresOf = (id: string): readonly string[] => {
  const descriptor = D8_DESCRIPTORS.find((item) => item.id === id);
  if (descriptor === undefined) throw new Error(`no D8 descriptor named ${id}`);
  return descriptor.requires;
};

describe("D8 descriptor coverage", () => {
  test("covers exactly the 18 C3 rows D8 owns, each once, and none of the I5 rows", () => {
    const liveRows = INVENTORY.filter((item) => D8_OWNED_ROWS.includes(item.id)).map(
      (item) => item.id,
    );
    const descriptorRows = D8_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);

    expect(D8_OWNED_ROWS).toHaveLength(18);
    expect([...liveRows].sort()).toEqual([...D8_OWNED_ROWS].sort());
    expect([...descriptorRows].sort()).toEqual([...D8_OWNED_ROWS].sort());
    expect(new Set(descriptorRows).size).toBe(descriptorRows.length);
    expect(D8_DESCRIPTORS.every((descriptor) => descriptor.owner === "D8")).toBe(true);
    expect(D8_DESCRIPTORS.every((descriptor) => descriptor.id.startsWith("D8."))).toBe(true);
    expect(descriptorRows.filter((row) => row.startsWith("D8."))).toEqual([]);
  });

  test("gives released goal operations the goal capability and each AP6-only feature its own seam", () => {
    expect(requiresOf("D8.goalShow")).toEqual(["omp.cmd.goal"]);
    expect(requiresOf("D8.goalPause")).toEqual(["omp.cmd.goal"]);
    expect(requiresOf("D8.goalResume")).toEqual(["omp.cmd.goal"]);
    expect(requiresOf("D8.goalDrop")).toEqual(["omp.cmd.goal"]);
    expect(requiresOf("D8.guidedGoalCommand")).toEqual(["omp.cmd.goal"]);
    expect(requiresOf("D8.guidedGoalInterview")).toEqual(["omp.cmd.goal"]);
    expect(requiresOf("D8.goalLaunchFlag")).toEqual([D8_AP6_CAPABILITIES.goalLaunch]);
    expect(requiresOf("D8.goalSet")).toEqual([D8_AP6_CAPABILITIES.goalUpdate]);
    expect(requiresOf("D8.goalBudget")).toEqual([D8_AP6_CAPABILITIES.goalUpdate]);
    expect(requiresOf("D8.loopCommand")).toEqual([D8_AP6_CAPABILITIES.loop]);
    expect(requiresOf("D8.loopStatus")).toEqual([D8_AP6_CAPABILITIES.loop]);
    expect(requiresOf("D8.tanCommand")).toEqual([D8_AP6_CAPABILITIES.tanDispatch]);
    expect(requiresOf("D8.vibeCommand")).toEqual([D8_AP6_CAPABILITIES.vibeWorker]);
    expect(requiresOf("D8.vibeStatus")).toEqual([D8_AP6_CAPABILITIES.vibeWorker]);
    expect(requiresOf("D8.ratchetCommand")).toEqual(["host.command-gateway"]);
  });

  test("claims a slash name only where omp's recorded RPC catalog lists it, from the same source", () => {
    const commands: readonly CommandDescriptor[] = D8_COMMAND_DESCRIPTORS;
    const claimed = commands.flatMap((command) =>
      command.slash === undefined ? [] : [command.slash],
    );
    expect(claimed.map((slash) => slash.name)).toEqual(["ratchet"]);
    for (const slash of claimed) {
      expect(catalog.commands).toContainEqual(
        expect.objectContaining({ name: slash.name, source: slash.source }),
      );
    }
  });

  test("passes C0 validation", () => {
    expect(validateRegistry(D8_DESCRIPTORS)).toEqual([]);
  });
});
