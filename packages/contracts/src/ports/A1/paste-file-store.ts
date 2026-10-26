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

/** A file's name in a chat's `local` folder: letters, digits, dots, dashes and underscores, not starting with a dot. */
const LocalFileName = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;

/**
 * A text file attached in the composer, saved for the chat under its own name as a file the agent can read with its
 * `local://` reference, as a large paste is (#2658). omp's prompt carries pictures only, so a text file is sent this way.
 */
export const PasteFileSaveFileArgs = z.strictObject({
  threadId: ThreadId,
  /** The attached file's name. The server makes it safe for a file name and unique in the folder. */
  name: z.string().min(1).max(256),
  text: z.string().max(MAX_ATTACHMENT_BYTES),
});
export type PasteFileSaveFileArgs = z.infer<typeof PasteFileSaveFileArgs>;

export const PasteFileSaveFileResult = z.strictObject({
  /** The file's name in the chat's `local` folder: the attached file's name made safe, with `-2`, `-3`… when it is taken. */
  name: z.string().regex(LocalFileName),
  /** What the message cites so the agent can read the file, for example `local://notes.txt`. */
  reference: z.string().regex(/^local:\/\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/),
});
export type PasteFileSaveFileResult = z.infer<typeof PasteFileSaveFileResult>;

export const PasteFileStore = definePort({
  name: "A1.pasteFileStore",
  methods: {
    save: {
      args: PasteFileSaveArgs,
      result: PasteFileSaveResult,
      capability: "host.attachments",
    },
    saveFile: {
      args: PasteFileSaveFileArgs,
      result: PasteFileSaveFileResult,
      capability: "host.attachments",
    },
  },
  events: {},
});
