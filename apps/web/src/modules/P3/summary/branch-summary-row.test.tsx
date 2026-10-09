import type { MessageState } from "@assistant-ui/react";
import type { OmpWire } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { BranchSummaryRow, branchSummaryOfRow } from "./branch-summary-row";

afterEach(cleanup);

const summary: OmpWire.BranchSummaryMessage = {
  role: "branchSummary",
  summary: "## Goal\n\nKeep the parser stable.",
  fromId: "entry-left",
  timestamp: 1_759_600_000_000,
};

/** A transcript row as R0 writes it: omp's role and message in the row's metadata. */
function rowWith(custom: Record<string, unknown>): MessageState {
  return {
    id: "entry:thread:b1",
    role: "system",
    content: [],
    metadata: { custom },
  } as unknown as MessageState;
}

describe("P3 branch summary row", () => {
  test("reads the branch summary R0 keeps on a row, and nothing else", () => {
    expect(
      branchSummaryOfRow(rowWith({ ompRole: "branchSummary", ompBranchSummary: summary })),
    ).toEqual(summary);
    expect(
      branchSummaryOfRow(rowWith({ ompRole: "custom", ompCustomType: "async-result" })),
    ).toBeUndefined();
    // A row marked as a branch summary but without its text is not drawn as one.
    expect(branchSummaryOfRow(rowWith({ ompRole: "branchSummary" }))).toBeUndefined();
    expect(
      branchSummaryOfRow(
        rowWith({ ompRole: "branchSummary", ompBranchSummary: { ...summary, timestamp: "x" } }),
      ),
    ).toBeUndefined();
  });

  test("draws the divider under the row's id, so the scroll and anchor code find the row", () => {
    const { container } = render(
      <BranchSummaryRow message={rowWith({ ompRole: "branchSummary" })} summary={summary} />,
    );
    const element = container.querySelector('[data-slot="p3-branch-summary-row"]');
    expect(element?.getAttribute("data-message-id")).toBe("entry:thread:b1");
    expect(element?.querySelector("[data-p3-branch-summary-divider]")).toBeTruthy();
    expect(screen.getByText("Branch summary")).toBeTruthy();
  });
});
