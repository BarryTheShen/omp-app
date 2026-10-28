// The branch_summary entry is recorded in P3's `p3-branch-summary` session recording (its last `get_entries` answer); its
// wire message shape is omp v18.12.6's session-entries.ts:170-178 and rpc-wire.generated.ts:195-200.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { convertMessage } from "@/modules/R0/runtime";
import { OmpRuntimeStore } from "@/modules/R0/store";
import {
  BRANCH_SUMMARY_ENTRY,
  BRANCH_SUMMARY_FROM_ID,
  BRANCH_SUMMARY_TEXT,
  branchSummaryMessage,
  SOURCE_CHAT,
  storedBranchSummary,
  storedUserText,
} from "../fixtures/omp-branch";
import { BranchSummaryDivider } from "../summary";

afterEach(cleanup);

const entries = [
  storedUserText(BRANCH_SUMMARY_FROM_ID, null, "Earlier question"),
  storedBranchSummary(
    BRANCH_SUMMARY_ENTRY,
    BRANCH_SUMMARY_FROM_ID,
    BRANCH_SUMMARY_FROM_ID,
    BRANCH_SUMMARY_TEXT,
  ),
];

/** The branch summary's message in a chat's store: omp's `branchSummary` message, as the store holds it. */
function summaryMessageOf(store: OmpRuntimeStore) {
  const snapshot = store.getSnapshot();
  const row = snapshot.messageOrder
    .map((key) => snapshot.messages[key])
    .find((candidate) => candidate?.message.role === "branchSummary");
  return row?.message;
}

describe("acceptance: a branch summary renders as a divider and keeps fromId", () => {
  test("the summary and the entry it left from survive a reload of the chat, and the divider draws them", () => {
    const opened = new OmpRuntimeStore({ threadId: SOURCE_CHAT });
    opened.pairEndedMessages(entries, BRANCH_SUMMARY_ENTRY);
    // A reload reads the same session file into a new store.
    const reloaded = new OmpRuntimeStore({ threadId: SOURCE_CHAT });
    reloaded.pairEndedMessages(entries, BRANCH_SUMMARY_ENTRY);

    const expected = branchSummaryMessage(BRANCH_SUMMARY_FROM_ID, BRANCH_SUMMARY_TEXT);
    expect(summaryMessageOf(opened)).toEqual(expected);
    expect(summaryMessageOf(reloaded)).toEqual(expected);

    // The transcript row carries omp's summary in its metadata, which the divider reads.
    const row = convertMessage(summaryMessageOf(reloaded));
    expect(row.metadata?.custom).toMatchObject({
      ompRole: "branchSummary",
      ompBranchSummary: expected,
    });

    const { container } = render(<BranchSummaryDivider message={expected} />);
    expect(
      container.querySelector("[data-p3-branch-summary-divider]")?.getAttribute("data-from-id"),
    ).toBe(String(BRANCH_SUMMARY_FROM_ID));
    fireEvent.click(screen.getByText("Branch summary"));
    expect(screen.getByRole("heading", { name: "Goal" })).toBeTruthy();
    expect(screen.getByText("Keep the original conversation.")).toBeTruthy();
  });

  test("an entry that names no summary text is not drawn as a branch summary", () => {
    const store = new OmpRuntimeStore({ threadId: SOURCE_CHAT });
    store.pairEndedMessages(
      [
        storedUserText(BRANCH_SUMMARY_FROM_ID, null, "Earlier question"),
        storedBranchSummary(
          BRANCH_SUMMARY_ENTRY,
          BRANCH_SUMMARY_FROM_ID,
          BRANCH_SUMMARY_FROM_ID,
          "",
        ),
      ],
      BRANCH_SUMMARY_ENTRY,
    );

    expect(summaryMessageOf(store)).toBeUndefined();
  });
});
