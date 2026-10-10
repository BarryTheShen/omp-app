import type { CommandDescriptor, ShortcutDescriptor } from "@omp-app/contracts";

/**
 * The palette command that opens the conversation copy picker over the open chat. It covers omp's
 * conversation copy selector (`D5.conversation-copy-selector` in the C0 inventory).
 */
export const D4_COPY_COMMAND = {
  kind: "command",
  id: "D4.copyFromChat",
  owner: "D4",
  title: "Copy from this chat",
  covers: ["D5.conversation-copy-selector"],
  requires: [],
} as const satisfies CommandDescriptor;

/** The shortcut that runs the same picker. The palette shows its chord beside the command. */
export const D4_COPY_SHORTCUT = {
  kind: "shortcut",
  id: "D4.copyFromChatShortcut",
  owner: "D4",
  title: "Copy from this chat",
  covers: [],
  requires: [],
  chord: "Alt+C",
  scope: "global",
} as const satisfies ShortcutDescriptor;

export const D4_COPY_DESCRIPTORS = [D4_COPY_COMMAND, D4_COPY_SHORTCUT] as const;
