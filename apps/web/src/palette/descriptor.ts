import type { CommandDescriptor, ShortcutDescriptor } from "@omp-app/contracts";

export const U0_COMMAND_PALETTE_SHORTCUT = {
  kind: "shortcut",
  id: "U0.commandPalette",
  owner: "U0",
  title: "Open command palette",
  covers: [],
  requires: [],
  chord: "Mod+K",
  scope: "global",
  allowInEditable: true,
} as const satisfies ShortcutDescriptor & { readonly allowInEditable: true };

/** The palette command that saves the app's debug log as a file to attach to a bug report. */
export const U0_SAVE_DEBUG_LOG_COMMAND = {
  kind: "command",
  id: "U0.saveDebugLog",
  owner: "U0",
  title: "Save debug log",
  covers: [],
  requires: [],
} as const satisfies CommandDescriptor;
