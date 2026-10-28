import type { Attachment } from "@assistant-ui/react";
import { AppFailure } from "@omp-app/contracts";
import { isPastedTextName } from "../attachments";

/*
 * omp's prompt carries pictures only (`images` on the chat host's `prompt`), so a text file attached in the composer is sent the
 * way a large paste saved as a file is: saved into the chat's `local` folder, and cited in the message by its `local://`
 * reference, which the agent reads (issue 2658). A pasted-text chip is not such a file: its text goes into the message as
 * omp's wrapped block (`withPastedText`). The reference is in the message text itself, so the sent text, the draft's
 * record of it and omp's echo of it are the same.
 */

/** Whether a composer attachment is a text file the message cites by reference: `text/*`, not a pasted-text chip. */
export function isTextFile(attachment: Attachment): boolean {
  return (
    attachment.type !== "image" &&
    (attachment.contentType ?? "").startsWith("text/") &&
    !isPastedTextName(attachment.name)
  );
}

/** The text of a data URL: base64 bytes read as UTF-8, or percent-encoded text. */
function textOfDataUrl(data: string): string {
  const comma = data.indexOf(",");
  if (comma < 0) return data;
  const header = data.slice(0, comma);
  const body = data.slice(comma + 1);
  if (!header.endsWith(";base64")) return decodeURIComponent(body);
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

/** The text of a text-file attachment: its stored content (a data URL) once attached, or the file still being added. */
export async function textOfAttachment(attachment: Attachment): Promise<string> {
  for (const part of attachment.content ?? []) {
    if (part.type === "file") return textOfDataUrl(part.data);
    if (part.type === "text") return part.text;
  }
  if (attachment.file !== undefined) return attachment.file.text();
  throw new AppFailure({
    code: "unavailable",
    message: `${attachment.name} could not be read, so the message was not sent.`,
    retryable: true,
  });
}

/** The message with the files' references after the typed text, one to a line. */
export function withReferences(text: string, references: readonly string[]): string {
  if (references.length === 0) return text;
  const cited = references.join("\n");
  return text.trim() === "" ? cited : `${text}\n\n${cited}`;
}

/**
 * The message as sent (issue 2658): each text file attached is saved into the chat's `local` folder by `save` and cited by its
 * reference after the typed text, and leaves the attachments, since omp's prompt carries pictures only. A file that
 * cannot be read or saved throws with a plain reason naming it, so nothing is sent.
 */
export async function withTextFilesSaved(
  text: string,
  attachments: readonly Attachment[],
  save: (name: string, text: string) => Promise<string>,
): Promise<{ readonly text: string; readonly attachments: readonly Attachment[] }> {
  const files = attachments.filter(isTextFile);
  if (files.length === 0) return { text, attachments };
  const references: string[] = [];
  for (const file of files) {
    const content = await textOfAttachment(file);
    try {
      references.push(await save(file.name, content));
    } catch (cause) {
      throw new AppFailure(
        {
          code: "unavailable",
          message: `${file.name} could not be saved for the agent to read, so the message was not sent.`,
          retryable: true,
        },
        { cause },
      );
    }
  }
  return {
    text: withReferences(text, references),
    attachments: attachments.filter((attachment) => !isTextFile(attachment)),
  };
}
