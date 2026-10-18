import type {
  CommandDescriptor,
  Descriptor,
  DialogDescriptor,
  PanelDescriptor,
  ShortcutDescriptor,
  StatusDescriptor,
} from "@omp-app/contracts";

export const P2_COMMAND_DESCRIPTORS = [
  {
    kind: "command",
    id: "P2.plan",
    owner: "P2",
    title: "Plan mode command",
    covers: ["P2.plan"],
    requires: ["client.plan-document", "upstream.plan-mode"],
    slash: { name: "plan", source: "builtin" },
  },
  {
    kind: "command",
    id: "P2.planReviewCommand",
    owner: "P2",
    title: "Plan review command",
    covers: ["P2.plan-review-command"],
    requires: ["client.plan-document", "upstream.plan-mode"],
    slash: { name: "plan-review", source: "builtin" },
  },
] as const satisfies readonly CommandDescriptor[];

export const P2_MODE_DESCRIPTORS = [
  {
    kind: "status",
    id: "P2.planMode",
    owner: "P2",
    title: "Plan mode",
    covers: ["P2.plan-mode"],
    requires: ["client.plan-document", "upstream.plan-mode"],
  },
  {
    kind: "status",
    id: "P2.planReviewMode",
    owner: "P2",
    title: "Plan review mode",
    covers: ["P2.plan-review-mode"],
    requires: ["client.plan-document", "upstream.plan-mode"],
  },
  {
    kind: "status",
    id: "P2.planModeStatus",
    owner: "P2",
    title: "Plan mode status",
    covers: ["P2.plan-mode-status"],
    requires: ["client.plan-document"],
  },
] as const satisfies readonly StatusDescriptor[];

export const P2_DIALOG_DESCRIPTORS = [
  {
    kind: "dialog",
    id: "P2.planAnnotationEditor",
    owner: "P2",
    title: "Plan annotation editor",
    covers: ["P2.plan-annotation-editor"],
    requires: ["client.plan-document", "omp.ui"],
  },
] as const satisfies readonly DialogDescriptor[];

export const P2_SHORTCUT_DESCRIPTORS = [
  {
    kind: "shortcut",
    id: "P2.appPlanToggle",
    owner: "P2",
    title: "Toggle plan mode",
    covers: ["P2.app-plan-toggle"],
    requires: ["client.plan-document", "upstream.plan-mode"],
    chord: "alt+shift+p",
    scope: "global",
  },
] as const satisfies readonly ShortcutDescriptor[];

export const P2_PANEL_DESCRIPTORS = [
  {
    kind: "panel",
    id: "P2.planReviewOverlay",
    owner: "P2",
    title: "Plan review",
    covers: ["P2.plan-review-overlay"],
    requires: ["client.plan-document", "omp.ui"],
  },
  {
    kind: "panel",
    id: "P2.planTableOfContents",
    owner: "P2",
    title: "Plan table of contents",
    covers: ["P2.plan-table-of-contents"],
    requires: ["client.plan-document", "omp.ui"],
  },
] as const satisfies readonly PanelDescriptor[];

export const P2_DESCRIPTORS: readonly Descriptor[] = [
  ...P2_COMMAND_DESCRIPTORS,
  ...P2_MODE_DESCRIPTORS,
  ...P2_DIALOG_DESCRIPTORS,
  ...P2_SHORTCUT_DESCRIPTORS,
  ...P2_PANEL_DESCRIPTORS,
];
