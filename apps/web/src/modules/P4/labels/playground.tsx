import { EntryId } from "@omp-app/contracts";
import { createRoot } from "react-dom/client";
import { Panel } from "@/components/blocks";
import type { ReadOnlyTreeLabel, TreeNode } from "../contract";
import { createP4LabelsViewModel, P4LabelsView } from ".";

const params = new URLSearchParams(window.location.search);
const empty = params.has("empty");
const labelsCapability = params.get("capability") === "available" ? "available" : "unavailable";
const labels: readonly ReadOnlyTreeLabel[] = empty
  ? []
  : [
      {
        targetId: EntryId.parse("p4-label-entry-1"),
        text: "Review checkpoint",
        editable: false,
        disabledReason: "Labels can't be changed here.",
      },
      {
        // A clear: omp keeps no label text for it, so it is not listed.
        targetId: EntryId.parse("p4-label-entry-2"),
        text: null,
        editable: false,
        disabledReason: "Labels can't be changed here.",
      },
    ];
// The entries the labels mark, as omp's tree carries them: their times tell the rows apart.
const tree: readonly TreeNode[] = empty
  ? []
  : [
      {
        entry: {
          type: "message",
          id: EntryId.parse("p4-label-entry-1"),
          parentId: null,
          timestamp: "2026-10-06T07:00:00.000Z",
        },
        children: [],
      },
      {
        entry: {
          type: "message",
          id: EntryId.parse("p4-label-entry-2"),
          parentId: null,
          timestamp: "2026-10-06T07:05:00.000Z",
        },
        children: [],
      },
    ];
const model = createP4LabelsViewModel({ labels, labelsCapability, tree });

function LabelsPlayground() {
  return (
    <main
      className="flex h-dvh min-h-0 w-full bg-background text-foreground"
      data-testid="p4-labels-playground"
    >
      <aside className="ml-auto h-dvh w-full min-w-0 shrink-0 sm:w-72">
        <Panel description="Browse the labels in this conversation." title="Conversation history">
          <P4LabelsView model={model} />
        </Panel>
      </aside>
    </main>
  );
}

const root = document.getElementById("p4-labels-playground-root");
if (!root) throw new Error("The labels preview could not be opened.");
createRoot(root).render(<LabelsPlayground />);
