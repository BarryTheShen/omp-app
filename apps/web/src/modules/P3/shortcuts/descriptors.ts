import type { ShortcutDescriptor } from "@omp-app/contracts";

/** A shortcut that also fires while focus is in the composer: the app's opt-in (shortcuts/registry.ts). */
type EditableShortcutDescriptor = ShortcutDescriptor & { readonly allowInEditable: true };

/**
 * omp's app.retry (inventory C2.app-retry, Alt+R): retries the failed turn the edit status offers with
 * "Try again". P3_DESCRIPTORS stays the message rows; this shortcut is listed on its own.
 */
export const P3_RETRY_SHORTCUT = {
  kind: "shortcut",
  id: "P3.appRetryShortcut",
  owner: "P3",
  title: "Retry the failed turn",
  covers: ["C2.app-retry"],
  requires: [],
  chord: "Alt+R",
  scope: "global",
  allowInEditable: true,
} as const satisfies EditableShortcutDescriptor;

export const P3_SHORTCUT_DESCRIPTORS = [
  P3_RETRY_SHORTCUT,
] as const satisfies readonly EditableShortcutDescriptor[];
