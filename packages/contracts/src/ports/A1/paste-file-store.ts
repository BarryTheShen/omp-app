import { z } from "zod";
import { definePort } from "../../core/envelope";
import { ThreadId } from "../../core/ids";
import { MAX_ATTACHMENT_BYTES } from "./attachment-store";

/** A large paste's full text, saved for the chat as a file the agent can read with its `local://` reference. */
export const PasteFileSaveArgs = z.strictObject({
  threadId: ThreadId,
  text: z.string().min(1).max(MAX_ATTACHMENT_BYTES),
});
export type PasteFileSaveArgs = z.infer<typeof PasteFileSaveArgs>;

export const PasteFileSaveResult = z.strictObject({
  /** The file's name in the chat's `local` folder: `paste-1.md`, then `paste-2.md`, and so on. */
  name: z.string().regex(/^paste-[1-9][0-9]*\.md$/),
  /** What the message cites so the agent can read the file, for example `local://paste-1.md`. */
  reference: z.string().regex(/^local:\/\/paste-[1-9][0-9]*\.md$/),
});
export type PasteFileSaveResult = z.infer<typeof PasteFileSaveResult>;

export const PasteFileStore = definePort({
  name: "A1.pasteFileStore",
  methods: {
    save: {
      args: PasteFileSaveArgs,
      result: PasteFileSaveResult,
      capability: "host.attachments",
    },
  },
  events: {},
});
