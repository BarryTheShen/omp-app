import { validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { R1_DESCRIPTORS } from "../descriptors";
import { R1_FIXTURE_COVERAGE, R1_INVENTORY_ROWS } from "../fixtures";

const sorted = (values: readonly string[]): string[] => [...values].sort();
const EXPECTED_FIXTURE_COVERAGE = [
  { inventoryId: "F3.open-session", scenario: "native-catalog-w3", proof: "open-handoff" },
  { inventoryId: "D2.resume", scenario: "native-catalog-w3", proof: "sidebar-resume" },
  {
    inventoryId: "D2.session-delete-confirmation",
    scenario: "native-catalog-w3",
    proof: "typed-delete-confirmation",
  },
  {
    inventoryId: "D2.session-pin-account-selector",
    scenario: "native-catalog-w3",
    proof: "typed-pin-cas",
  },
  { inventoryId: "D2.session-selector", scenario: "native-catalog-w3", proof: "sidebar-selector" },
  {
    inventoryId: "D2.app-session-delete",
    scenario: "descriptor-audit",
    proof: "shortcut-descriptor",
  },
  {
    inventoryId: "D2.app-session-deletenoninvasive",
    scenario: "descriptor-audit",
    proof: "shortcut-descriptor",
  },
  {
    inventoryId: "D2.app-session-fork",
    scenario: "not-offered",
    proof: "the session list has no fork action",
  },
  {
    inventoryId: "D2.app-session-new",
    scenario: "native-catalog-w3",
    proof: "new-session-handoff",
  },
  {
    inventoryId: "D2.app-session-observe",
    scenario: "not-offered",
    proof: "the app has no observe view",
  },
  { inventoryId: "D2.app-session-rename", scenario: "native-catalog-w3", proof: "typed-rename" },
  { inventoryId: "D2.app-session-resume", scenario: "native-catalog-w3", proof: "sidebar-resume" },
  {
    inventoryId: "D2.app-session-togglepath",
    scenario: "not-offered",
    proof: "the session list shows no path to toggle",
  },
  {
    inventoryId: "D2.app-session-togglesort",
    scenario: "not-offered",
    proof: "the session list has no sort order to toggle",
  },
] as const satisfies typeof R1_FIXTURE_COVERAGE;

describe("R1 inventory and fixture audit", () => {
  test("every F3/D2 row is declared once, or its fixture says the app realises it natively or does not offer it", () => {
    const descriptorRows: string[] = R1_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    const undeclared = R1_INVENTORY_ROWS.filter((row) => !descriptorRows.includes(row));

    expect(new Set(descriptorRows).size).toBe(descriptorRows.length);
    expect(sorted([...descriptorRows, ...undeclared])).toEqual(sorted(R1_INVENTORY_ROWS));
    expect(
      undeclared.map((row) => [
        row,
        R1_FIXTURE_COVERAGE.find((coverage) => coverage.inventoryId === row)?.scenario,
      ]),
    ).toEqual([
      ["D2.app-session-fork", "not-offered"],
      ["D2.app-session-new", "native-catalog-w3"],
      ["D2.app-session-observe", "not-offered"],
      ["D2.app-session-resume", "native-catalog-w3"],
      ["D2.app-session-togglepath", "not-offered"],
      ["D2.app-session-togglesort", "not-offered"],
    ]);
    expect(R1_DESCRIPTORS.every((descriptor) => descriptor.owner === "R1")).toBe(true);
    expect(R1_DESCRIPTORS.every((descriptor) => descriptor.id.startsWith("R1."))).toBe(true);
  });

  test("maps every descriptor row to a named acceptance fixture proof", () => {
    const fixtureRows = R1_FIXTURE_COVERAGE.map((coverage) => coverage.inventoryId);

    expect(sorted(fixtureRows)).toEqual(sorted(R1_INVENTORY_ROWS));
    expect(new Set(fixtureRows).size).toBe(fixtureRows.length);
    expect(R1_FIXTURE_COVERAGE).toEqual(EXPECTED_FIXTURE_COVERAGE);
  });

  test("passes the C0 registry validator without claiming another module", () => {
    expect(validateRegistry(R1_DESCRIPTORS)).toEqual([]);
  });
});
