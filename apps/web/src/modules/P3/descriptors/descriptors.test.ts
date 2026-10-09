import { INVENTORY, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { P3_DESCRIPTORS, P3_DIALOG_DESCRIPTORS, P3_MESSAGE_DESCRIPTORS } from ".";

const ownedRows = ["P3.branch-message-selector", "P3.branch-summary-divider"];

describe("P3 descriptor coverage", () => {
  test("claims exactly the two P3 rows assigned to this module part", () => {
    const liveRows = INVENTORY.filter((item) => ownedRows.includes(item.id)).map((item) => item.id);
    const descriptorRows = P3_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);

    expect([...liveRows].sort()).toEqual([...ownedRows].sort());
    expect([...descriptorRows].sort()).toEqual([...ownedRows].sort());
    expect(new Set(descriptorRows).size).toBe(descriptorRows.length);
    expect(P3_DESCRIPTORS.every((descriptor) => descriptor.owner === "P3")).toBe(true);
    expect(P3_DESCRIPTORS.every((descriptor) => descriptor.id.startsWith("P3."))).toBe(true);
  });

  test("matches branch summaries by role and gates the selector on typed history", () => {
    expect(P3_MESSAGE_DESCRIPTORS).toEqual([
      expect.objectContaining({
        id: "P3.branchSummaryDivider",
        match: { by: "role", role: "branchSummary" },
      }),
    ]);
    expect(P3_DIALOG_DESCRIPTORS).toEqual([
      expect.objectContaining({
        id: "P3.branchMessageSelector",
        requires: ["omp.cmd.get_branch_messages", "omp.cmd.branch"],
      }),
    ]);
  });

  test("passes C0 validation without claiming a command namespace", () => {
    expect(validateRegistry(P3_DESCRIPTORS)).toEqual([]);
  });
});
