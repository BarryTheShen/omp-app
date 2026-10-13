import type { MessageState } from "@assistant-ui/react";
import type { OmpWire } from "@omp-app/contracts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { CompactionSummaryRow, compactionSummaryOfRow } from "./compaction-summary-row";

afterEach(cleanup);

const summary: OmpWire.CompactionSummaryMessage = {
  role: "compactionSummary",
  summary: "## Kept context\n\n- Keep the current goal",
  tokensBefore: 120_000,
  tokensAfter: 28_000,
  timestamp: 1_759_600_000_000,
  method: "remote",
};

function rowWith(custom: Record<string, unknown>): MessageState {
  return { id: "entry:thread:c1", metadata: { custom } } as unknown as MessageState;
}

describe("compactionSummaryOfRow", () => {
  test("reads omp's compaction message that R0 keeps in the row's metadata", () => {
    expect(
      compactionSummaryOfRow(
        rowWith({ ompRole: "compactionSummary", ompCompactionSummary: summary }),
      ),
    ).toEqual(summary);
  });

  test("gives undefined for other rows and for a compaction row without its counts", () => {
    expect(
      compactionSummaryOfRow(rowWith({ ompRole: "custom", ompCustomType: "async-result" })),
    ).toBeUndefined();
    expect(compactionSummaryOfRow(rowWith({ ompRole: "compactionSummary" }))).toBeUndefined();
    expect(
      compactionSummaryOfRow(
        rowWith({
          ompRole: "compactionSummary",
          ompCompactionSummary: { ...summary, tokensBefore: "120000" },
        }),
      ),
    ).toBeUndefined();
  });
});

describe("CompactionSummaryRow", () => {
  test("draws the divider under the row's id; expanding it shows the method and the token counts", () => {
    const row = rowWith({ ompRole: "compactionSummary", ompCompactionSummary: summary });
    const { container, getByRole, getByText } = render(
      <CompactionSummaryRow message={row} summary={summary} />,
    );
    const element = container.querySelector('[data-slot="p7-compaction-summary-row"]');
    expect(element?.getAttribute("data-message-id")).toBe("entry:thread:c1");
    expect(container.querySelector("[data-p7-compaction-divider]")).not.toBeNull();
    fireEvent.click(getByRole("button", { name: "Conversation compacted remotely" }));
    expect(getByText(/Before compaction: 120,000 tokens/)).toBeTruthy();
  });
});
