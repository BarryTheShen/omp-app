import type { OmpWire } from "@omp-app/contracts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BranchSummaryDivider } from "./index";

const branchSummary: OmpWire.BranchSummaryMessage = {
  role: "branchSummary",
  summary:
    "## Kept branch\n\n- The original conversation remains available.\n- The new conversation starts from the selected message.\n\nThis summary is shown with the same Markdown treatment as the transcript.",
  fromId: "entry-parent-42",
  timestamp: 1_759_600_000_000,
};

const emptySummary: OmpWire.BranchSummaryMessage = {
  role: "branchSummary",
  summary: "",
  fromId: "entry-without-summary",
  timestamp: 1_759_600_000_001,
};

function BranchSummaryPlayground() {
  return (
    <main className="min-h-dvh space-y-(--space-xl) bg-background px-(--space-xl) py-(--space-2xl) text-foreground">
      <header className="mx-auto max-w-3xl space-y-(--space-xs)">
        <h1 className="text-2xl font-semibold tracking-tight">Branch summary preview</h1>
        <p className="text-muted-foreground text-sm">
          Expand a branch summary to read it without changing the conversation.
        </p>
      </header>
      <section
        aria-label="Conversation history"
        className="mx-auto max-w-3xl rounded-(--radius) border border-border bg-card p-(--space-md)"
      >
        <BranchSummaryDivider message={branchSummary} />
        <BranchSummaryDivider message={emptySummary} />
      </section>
    </main>
  );
}

const root = document.getElementById("p3-5-branch-summary-playground-root");
if (!root) throw new Error("The branch summary preview is missing its root element.");
createRoot(root).render(
  <StrictMode>
    <BranchSummaryPlayground />
  </StrictMode>,
);
