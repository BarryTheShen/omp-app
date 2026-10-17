import { INVENTORY, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { I3_DESCRIPTORS } from "../../descriptors";
import {
  I3_MEMORY_INVENTORY_ROWS,
  I3_OWNED_INVENTORY_ROWS,
  I3_SETTINGS_INVENTORY_ROWS,
} from "../../fixtures";

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("I3.5 descriptor ownership and CC12 gate", () => {
  test("owns the fifteen memory rows and five memory settings groups exactly", () => {
    const contractMemoryRows = INVENTORY.filter(
      (item) => item.group === "C4" && item.id.startsWith("C4.memory"),
    ).map((item) => item.id);
    const contractSettingsRows = INVENTORY.filter(
      (item) => item.group === "S5" && item.id.startsWith("S5.memory-"),
    ).map((item) => item.id);

    expect(sorted(I3_MEMORY_INVENTORY_ROWS)).toEqual(sorted(contractMemoryRows));
    expect(sorted(I3_SETTINGS_INVENTORY_ROWS)).toEqual(sorted(contractSettingsRows));
  });

  test("keeps the rules browser app-only and settings claims typed", () => {
    const rules = I3_DESCRIPTORS.find((descriptor) => descriptor.id === "I3.rules");
    expect(rules).toMatchObject({
      kind: "panel",
      owner: "I3",
      covers: [],
      requires: ["host.rules"],
    });

    const settings = I3_DESCRIPTORS.filter(
      (descriptor): descriptor is Extract<(typeof I3_DESCRIPTORS)[number], { kind: "setting" }> =>
        descriptor.kind === "setting",
    );
    expect(settings).toHaveLength(5);
    expect(settings.every((descriptor) => descriptor.section?.startsWith("memory/"))).toBe(true);
  });

  test("has one descriptor claim per owned row and validates against C0", () => {
    const descriptorRows = I3_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);

    expect(sorted(descriptorRows)).toEqual(sorted(I3_OWNED_INVENTORY_ROWS));
    expect(new Set(descriptorRows).size).toBe(descriptorRows.length);
    expect(validateRegistry(I3_DESCRIPTORS)).toEqual([]);
  });
});
