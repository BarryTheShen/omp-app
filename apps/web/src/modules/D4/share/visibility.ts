import { type ShareVisibility, ShareVisibilitySchema } from "../contract";

/**
 * The `upstream.share-visibility` gate. omp 18.6.1 makes one kind of link: `/share` takes no
 * arguments and has no revoke (`slash-commands/builtin-collaboration.ts:284-309`,
 * `commands/share.ts:30-35`). Private and team links stay unavailable until omp provides them. The
 * reason is shown in place of a control, and no visibility control is rendered.
 */
export const SHARE_VISIBILITY: ShareVisibility = ShareVisibilitySchema.parse({
  state: "unavailable",
  capability: "upstream.share-visibility",
  reason:
    "omp can only make one kind of link, and anyone who has it can open the chat. Private and team links need omp to add them first.",
});
