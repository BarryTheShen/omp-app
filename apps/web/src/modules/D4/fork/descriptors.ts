import type { CommandDescriptor } from "@omp-app/contracts";

/**
 * What the palette says while omp cannot import: the command is listed, disabled, with this reason, and asks
 * nothing. The composition passes it to the palette for this command's id.
 */
export const SHARE_IMPORT_UNAVAILABLE_REASON =
  "omp can't import shared chats in this version. Importing needs a newer version of omp.";

/**
 * The palette command that makes a new chat from a share link someone sent. omp has no command for this, so it is
 * app-only and claims no inventory row. It needs the session-import host capability and the upstream gate: while
 * omp cannot import, the palette lists it as unavailable with SHARE_IMPORT_UNAVAILABLE_REASON and asks nothing.
 */
export const D4_IMPORT_SHARE_COMMAND = {
  kind: "command",
  id: "D4.importShare",
  owner: "D4",
  title: "Import a shared chat",
  covers: [],
  requires: ["host.session-import", "upstream.session-import"],
} as const satisfies CommandDescriptor;

export const D4_FORK_DESCRIPTORS = [D4_IMPORT_SHARE_COMMAND] as const;
