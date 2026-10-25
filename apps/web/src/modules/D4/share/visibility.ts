import { type ShareVisibility, ShareVisibilitySchema } from "../contract";

/**
 * The `upstream.share-visibility` gate. omp 18.12.6 makes one kind of link: `/share` takes no
 * arguments and has no revoke (`slash-commands/builtin-collaboration.ts:292-317`,
 * `commands/share.ts:30-35`; `--gist` and `share.store` only choose where that one link is stored).
 * Private and team links stay unavailable until omp provides them. The reason is shown in place of a
 * control, and no visibility control is rendered.
 */
export const SHARE_VISIBILITY: ShareVisibility = ShareVisibilitySchema.parse({
  state: "unavailable",
  capability: "upstream.share-visibility",
  reason:
    "omp can only make one kind of link, and anyone who has it can open the chat. Private and team links need omp to add them first.",
});
