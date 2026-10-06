import type { ShortcutDescriptor } from "@omp-app/contracts";

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
