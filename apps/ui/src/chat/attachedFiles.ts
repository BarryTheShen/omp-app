/**
 * Files in the message box (#2830). A picture still goes to the model with the message; any other file is uploaded to the
 * chat's own folder on the server, omp's `local://`, as it is attached, and the message names it in a paragraph after
 * the text (`vendor/collab-web/lib/attached.ts`). omp's tools read such a file as `local://<name>` and move it where
 * they are asked.
 */

/** The largest file a message takes, in bytes: the server's upload limit (`MAX_UPLOAD_BYTES`). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** A file in the message box, waiting to be sent. */
export interface AttachedFile {
  readonly id: string;
  /** Its name in the chat's folder: the file's own, or `name (n).ext` when the folder holds that name. */
  readonly name: string;
  /** Its size as the chip and the message say it ("2.4 MB"). */
  readonly size: string;
  /** The share uploaded so far, 0 to 1; null once the file is in the chat's folder. */
  readonly progress: number | null;
  /** Uploaded from this box and not sent: taking it out of the box takes it out of the folder too. */
  readonly own: boolean;
}
