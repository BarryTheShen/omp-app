import { validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { R1_DESCRIPTORS } from "../descriptors";
import { R1_FIXTURE_COVERAGE, R1_INVENTORY_ROWS } from "../fixtures";

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("R1 inventory and fixture audit", () => {
  test("has exactly one descriptor for every F3/D2 inventory row", () => {
    const descriptorRows = R1_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);

    expect(sorted(descriptorRows)).toEqual(sorted(R1_INVENTORY_ROWS));
    expect(new Set(descriptorRows).size).toBe(descriptorRows.length);
    expect(R1_DESCRIPTORS.every((descriptor) => descriptor.owner === "R1")).toBe(true);
    expect(R1_DESCRIPTORS.every((descriptor) => descriptor.id.startsWith("R1."))).toBe(true);
  });

  test("maps every descriptor row to a named acceptance fixture proof", () => {
    const fixtureRows = R1_FIXTURE_COVERAGE.map((coverage) => coverage.inventoryId);

    expect(sorted(fixtureRows)).toEqual(sorted(R1_INVENTORY_ROWS));
    expect(new Set(fixtureRows).size).toBe(fixtureRows.length);
    for (const row of R1_INVENTORY_ROWS) {
      const coverage = R1_FIXTURE_COVERAGE.find((item) => item.inventoryId === row);
      expect(coverage?.scenario).toBeDefined();
      expect(coverage?.proof).toBeTruthy();
    }
  });

  test("passes the C0 registry validator without claiming another module", () => {
    expect(validateRegistry(R1_DESCRIPTORS)).toEqual([]);
  });
});
