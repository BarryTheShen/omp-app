import { checkScrubbed, INVENTORY, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { U2Descriptors } from "../descriptors";
import { U2_FIXTURE_COVERAGE, U2_INVENTORY_ROWS, U2_STATE_FIXTURES } from "../fixtures";

const sorted = (values: readonly string[]): string[] => [...values].sort();
const sourceRows = INVENTORY.filter((item) => item.group === "F5" || item.group === "C6").map(
  (item) => item.id,
);

describe("U2 inventory and fixture audit", () => {
  test("has exactly one composer descriptor for every U2 F5/C6 inventory row", () => {
    const descriptorRows = U2Descriptors.flatMap((descriptor) => descriptor.covers);

    expect(sorted(U2_INVENTORY_ROWS)).toEqual(sorted(sourceRows));
    expect(sorted(descriptorRows)).toEqual(sorted(U2_INVENTORY_ROWS));
    expect(new Set(descriptorRows).size).toBe(descriptorRows.length);
    expect(U2Descriptors.every((descriptor) => descriptor.owner === "U2")).toBe(true);
    expect(U2Descriptors.every((descriptor) => descriptor.id.startsWith("U2."))).toBe(true);
  });

  test("maps every owned row once to a scrubbed R0 acceptance fixture and proof", () => {
    const fixtureRows = U2_FIXTURE_COVERAGE.map((coverage) => coverage.inventoryId);

    expect(sorted(fixtureRows)).toEqual(sorted(U2_INVENTORY_ROWS));
    expect(new Set(fixtureRows).size).toBe(fixtureRows.length);
    for (const coverage of U2_FIXTURE_COVERAGE) {
      expect(U2_STATE_FIXTURES[coverage.fixture].scenario).toBeTruthy();
      expect(coverage.proof).toBeTruthy();
    }
    expect(checkScrubbed(JSON.stringify(U2_STATE_FIXTURES))).toEqual([]);
  });

  test("accepts the complete descriptors through C0 registry validation", () => {
    expect(validateRegistry(U2Descriptors)).toEqual([]);
  });
});
