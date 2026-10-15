import type { CommandDescriptor, Descriptor } from "@omp-app/contracts";
import { D4_COPY_COMMAND, D4_COPY_SHORTCUT } from "../copy/descriptors";
import { D4_FORK_DESCRIPTORS } from "../fork/descriptors";
import { D4_SHARE_DESCRIPTORS } from "../share/descriptors";

/**
 * The copy command, with the `/copy` slash name and its inventory row, `D5.copy` (omp's terminal-only `/copy` picker).
 * The id stays `D4.copyFromChat`, so the handler mounted with the open chat runs this command too, typed or picked.
 */
const D4_COPY_CHAT_COMMAND = {
  ...D4_COPY_COMMAND,
  covers: [...D4_COPY_COMMAND.covers, "D5.copy"],
  slash: { name: "copy", source: "builtin" },
} as const satisfies CommandDescriptor;

/**
 * Every descriptor D4 registers, composed once for the app's registry: the copy command and its shortcut, the share
 * command and the import command. The five export commands are not in this list until they are mounted (follow-up
 * issue 1683), so their inventory rows stay uncovered until then. Across this list each reachable D5 inventory row is
 * covered exactly once, and each slash name here is claimed once; `validateRegistry` checks both.
 */
export const D4_DESCRIPTORS = [
  D4_COPY_CHAT_COMMAND,
  D4_COPY_SHORTCUT,
  ...D4_SHARE_DESCRIPTORS,
  ...D4_FORK_DESCRIPTORS,
] as const satisfies readonly Descriptor[];
