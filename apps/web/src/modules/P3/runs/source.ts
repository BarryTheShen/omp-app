import type { EntryId, OmpWire } from "@omp-app/contracts";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { TranscriptContentReader } from "@/modules/U1/copy";
import type { P3EditSource } from "../edit";

/** Whether a value is an image with its bytes: the only attachment omp keeps in a session file. */
export function isImageContent(value: unknown): value is OmpWire.ImageContent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "image" &&
    "data" in value &&
    typeof value.data === "string" &&
    "mimeType" in value &&
    typeof value.mimeType === "string"
  );
}

/**
 * The entry id of a transcript row this chat stores. The row id is the message key, which is not the
 * entry id: a stored row carries its entry id on its record. A row omp has not saved yet (a message
 * still streaming, or one that has ended without an entry) has none, so it gets no actions.
 */
export function storedEntryId(store: OmpRuntimeStore, messageKey: string): EntryId | null {
  const snapshot = store.getSnapshot();
  const entryId = snapshot.messageOrder
    .map((key) => snapshot.messages[key])
    .find((candidate) => candidate?.key === messageKey)?.entryId;
  if (entryId === undefined || snapshot.transcript.entries[entryId] === undefined) return null;
  return entryId;
}

/**
 * The exact source of one stored user message, read from U1's raw transcript content. Returns null when
 * the chat holds no user message with that entry id. omp's session files keep the text and the images,
 * not the attachment refs (those are U2 draft state), so the source carries no refs.
 */
export function captureP3EditSource(store: OmpRuntimeStore, entryId: EntryId): P3EditSource | null {
  const snapshot = store.getSnapshot();
  const entry = snapshot.transcript.entries[entryId];
  const message = snapshot.messageOrder
    .map((key) => snapshot.messages[key])
    .find((candidate) => candidate?.entryId === entryId);
  if (!entry || !message || message.message.role !== "user") return null;
  const content = TranscriptContentReader.read(message);
  const originalText = content.parts
    .filter((part) => part.type === "text")
    .map((part) => part.plainText ?? "")
    .join("");
  const originalImages = content.parts.flatMap((part) =>
    part.type === "image" && isImageContent(part.source) ? [part.source] : [],
  );
  return {
    editSource: {
      threadId: snapshot.threadId,
      entryId,
      parentId: entry.parentId,
      originalText,
      originalImages,
      // No assistant-ui branch repository is mounted yet, so there is no head to record.
      sourceHeadId: null,
    },
    composerSource: {
      text: originalText,
      images: originalImages,
      attachmentRefs: [],
      sourceMessageId: String(entryId),
    },
  };
}
