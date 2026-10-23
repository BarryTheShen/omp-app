import { INVENTORY, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { D1_DESCRIPTORS } from "../descriptors";
import { D1_FIXTURE_COVERAGE, D1_INVENTORY_ROWS, D1_SETTINGS_INVENTORY_ROWS } from "../fixtures";

const sorted = (values: readonly string[]): string[] => [...values].sort();
const ownedInventoryRows = [...D1_INVENTORY_ROWS, ...D1_SETTINGS_INVENTORY_ROWS];

describe("D1 CC4/CC10/CC12 descriptor gate", () => {
  test("assigns every D1 inventory row and each D1-owned S2 settings row exactly once", () => {
    const liveD1Rows = INVENTORY.filter((item) => item.group === "D1").map((item) => item.id);
    const liveD1SettingsRows = INVENTORY.filter(
      (item) =>
        item.group === "S2" && item.id.startsWith("S2.model-") && item.id !== "S2.model-advisor",
    ).map((item) => item.id);
    const descriptorRows = D1_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);

    expect(sorted(D1_INVENTORY_ROWS)).toEqual(sorted(liveD1Rows));
    expect(sorted(D1_SETTINGS_INVENTORY_ROWS)).toEqual(sorted(liveD1SettingsRows));
    // Each owned row is declared by exactly one descriptor.
    expect(sorted(descriptorRows)).toEqual(sorted(ownedInventoryRows));
    expect(new Set(descriptorRows).size).toBe(descriptorRows.length);
    expect(D1_DESCRIPTORS.every((descriptor) => descriptor.owner === "D1")).toBe(true);
    expect(D1_DESCRIPTORS.every((descriptor) => descriptor.id.startsWith("D1."))).toBe(true);
  });

  test("gives every inventory row one named gate fixture or descriptor proof", () => {
    const fixtureRows = D1_FIXTURE_COVERAGE.map((coverage) => coverage.inventoryId);

    expect(sorted(fixtureRows)).toEqual(sorted(ownedInventoryRows));
    expect(new Set(fixtureRows).size).toBe(fixtureRows.length);
    expect(D1_FIXTURE_COVERAGE.every((coverage) => coverage.scenario && coverage.proof)).toBe(true);
  });

  test("passes the C0 registry validator without claiming another module's namespace", () => {
    expect(validateRegistry(D1_DESCRIPTORS)).toEqual([]);
  });
});
