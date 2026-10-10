import type { CommandDescriptor } from "@omp-app/contracts";

/**
 * The palette command that shares the open chat. It covers omp's `/share` (`D5.share` in the C0 inventory) and
 * runs the same flow as typed `/share`: the question first, then the upload. omp's own `/share` never runs unasked.
 */
export const D4_SHARE_COMMAND = {
  kind: "command",
  id: "D4.shareChat",
  owner: "D4",
  title: "Share this chat",
  covers: ["D5.share"],
  requires: ["host.command-gateway"],
  slash: { name: "share", source: "builtin" },
} as const satisfies CommandDescriptor;

export const D4_SHARE_DESCRIPTORS = [D4_SHARE_COMMAND] as const;
