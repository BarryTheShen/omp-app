import {
  type CapabilityKey,
  type Descriptor,
  type InventoryId,
  NAMESPACE_OWNERSHIP,
  validateRegistry,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  D6_BTW_CAPABILITIES,
  D6_CAPABILITIES,
  D6_DESCRIPTORS,
  D6_PANEL_DESCRIPTORS,
} from "../descriptors";
import { D6_FALLBACK_FIXTURES } from "../fixtures";
import { D6_REPORT_PALETTE_COMMANDS } from "../reports";
import { D6_FALLBACK_ROWS, D6_OWNED_ROWS } from "./owned-rows";

const D6_REGISTRY: readonly Descriptor[] = [...D6_REPORT_PALETTE_COMMANDS, ...D6_DESCRIPTORS];
const D6_BTW_ROWS = new Set<InventoryId>(["C3.btw", "C3.btw-side-panel"]);

function requiredCapabilities(row: InventoryId): readonly CapabilityKey[] {
  if (D6_BTW_ROWS.has(row)) return D6_BTW_CAPABILITIES;
  return D6_FALLBACK_ROWS.includes(row)
    ? [D6_CAPABILITIES.fallback]
    : [D6_CAPABILITIES.commandGateway];
}

function hasRequiredCapabilities(descriptor: Descriptor, row: InventoryId): boolean {
  return requiredCapabilities(row).every((capability) => descriptor.requires.includes(capability));
}

function gateState(descriptors: readonly Descriptor[], rows: readonly InventoryId[]) {
  const covered = descriptors.flatMap((descriptor) => descriptor.covers);
  const c1Count = rows.filter((row) => row.startsWith("C1.")).length;
  const c3Count = rows.filter((row) => row.startsWith("C3.")).length;
  const capabilitiesValid = descriptors.every((descriptor) =>
    descriptor.covers.every((row) => hasRequiredCapabilities(descriptor, row)),
  );
  return {
    countsValid: c1Count === 19 && c3Count === 10,
    coverageValid:
      covered.length === rows.length &&
      new Set(covered).size === covered.length &&
      rows.every((row) => covered.includes(row)),
    capabilitiesValid,
  };
}

describe("CC12: D6 owns every diagnostic and operational row exactly once", () => {
  test("the inventory-backed table contains all 19 C1 and 10 C3 rows", () => {
    expect(D6_OWNED_ROWS.filter((row) => row.startsWith("C1.")).length).toBe(19);
    expect(D6_OWNED_ROWS.filter((row) => row.startsWith("C3.")).length).toBe(10);
    expect(D6_OWNED_ROWS).toContain("C1.report-panel");
    expect(D6_OWNED_ROWS).toContain("C3.debug-selector");
    expect(new Set(D6_OWNED_ROWS).size).toBe(D6_OWNED_ROWS.length);
  });

  test("the combined D6.3 and D6.6 registry has no duplicate ids or claims", () => {
    expect(validateRegistry(D6_REGISTRY)).toEqual([]);
  });

  test("the combined registry covers every D6 row once with its required capability", () => {
    expect(gateState(D6_REGISTRY, D6_OWNED_ROWS)).toEqual({
      countsValid: true,
      coverageValid: true,
      capabilitiesValid: true,
    });
    expect(D6_FALLBACK_FIXTURES.map((fixture) => fixture.inventoryId).sort()).toEqual(
      [...D6_FALLBACK_ROWS].sort(),
    );
  });

  test("the four D6 panel descriptors cover D6 namespaces and the generic report surface", () => {
    expect(D6_PANEL_DESCRIPTORS).toHaveLength(4);
    for (const panel of D6_PANEL_DESCRIPTORS) {
      const namespace = panel.id.slice("D6.".length);
      const claim = NAMESPACE_OWNERSHIP.find(
        (candidate) => candidate.kind === "panel" && candidate.namespace === namespace,
      );
      if (panel.id === "D6.reportPanel") {
        expect(claim).toBeUndefined();
        continue;
      }
      expect(claim?.status).toBe("owned");
      if (claim?.status === "owned") expect(claim.owner).toBe("D6");
    }
  });

  test("mutation probes reject changed covers, a dropped row and a changed requires key", () => {
    const changedCovers = D6_DESCRIPTORS.map(
      (descriptor): Descriptor =>
        descriptor.id === "D6.securityValidate"
          ? { ...descriptor, covers: ["P4.stats"] }
          : descriptor,
    );
    const changedCoverage = gateState(
      [...D6_REPORT_PALETTE_COMMANDS, ...changedCovers],
      D6_OWNED_ROWS,
    );
    expect(changedCoverage.coverageValid).toBe(false);

    const droppedRow = "C3.debug-selector";
    const shortenedRows = D6_OWNED_ROWS.filter((row) => row !== droppedRow);
    const shortenedDescriptors = D6_DESCRIPTORS.map(
      (descriptor): Descriptor => ({
        ...descriptor,
        covers: descriptor.covers.filter((row) => row !== droppedRow),
      }),
    );
    expect(
      gateState([...D6_REPORT_PALETTE_COMMANDS, ...shortenedDescriptors], shortenedRows)
        .countsValid,
    ).toBe(false);

    const changedRequires = D6_DESCRIPTORS.map(
      (descriptor): Descriptor =>
        descriptor.id === "D6.securityValidate"
          ? { ...descriptor, requires: [D6_CAPABILITIES.fallback] }
          : descriptor,
    );
    expect(
      gateState([...D6_REPORT_PALETTE_COMMANDS, ...changedRequires], D6_OWNED_ROWS)
        .capabilitiesValid,
    ).toBe(false);
    const changedBtwRequires = D6_DESCRIPTORS.map(
      (descriptor): Descriptor =>
        descriptor.id === "D6.btw"
          ? { ...descriptor, requires: [D6_CAPABILITIES.fallback] }
          : descriptor,
    );
    expect(
      gateState([...D6_REPORT_PALETTE_COMMANDS, ...changedBtwRequires], D6_OWNED_ROWS)
        .capabilitiesValid,
    ).toBe(false);
  });
});
