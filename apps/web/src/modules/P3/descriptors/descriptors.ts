import type { Descriptor, DialogDescriptor, MessageDescriptor } from "@omp-app/contracts";

/** P3 owns the assistant-ui branch summary row and the typed previous-message selector. */
export const P3_MESSAGE_DESCRIPTORS = [
  {
    kind: "message",
    id: "P3.branchSummaryDivider",
    owner: "P3",
    title: "Branch summary divider",
    covers: ["P3.branch-summary-divider"],
    requires: [],
    match: { by: "role", role: "branchSummary" },
  },
] as const satisfies readonly MessageDescriptor[];

export const P3_DIALOG_DESCRIPTORS = [
  {
    kind: "dialog",
    id: "P3.branchMessageSelector",
    owner: "P3",
    title: "Previous message selector",
    covers: ["P3.branch-message-selector"],
    requires: ["omp.cmd.get_branch_messages", "omp.cmd.branch"],
  },
] as const satisfies readonly DialogDescriptor[];

export const P3_DESCRIPTORS = [
  ...P3_MESSAGE_DESCRIPTORS,
  ...P3_DIALOG_DESCRIPTORS,
] as const satisfies readonly Descriptor[];

export type P3Descriptor = (typeof P3_DESCRIPTORS)[number];
