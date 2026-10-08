import { type KeyedTranscriptMessage, TranscriptContentReader } from "@/modules/U1/copy";
import type { CopyAuthor, CopySourceMessage } from "./targets";

/** Who wrote a message, as the copy picker names it. Roles not listed have no author in the picker. */
const AUTHOR_BY_ROLE: Readonly<Partial<Record<string, CopyAuthor>>> = {
  assistant: "omp",
  bashExecution: "you",
  pythonExecution: "you",
  user: "you",
};

/** Reads a chat's keyed messages, in transcript order, into copy sources. */
export type CopySourceReader = (
  entries: readonly KeyedTranscriptMessage[],
) => readonly CopySourceMessage[];

/**
 * Builds a reader over U1.7's raw content. The reader is held here, so a message the store hands back
 * unchanged keeps its cached raw record. D4 reads raw content only; it never reads rendered DOM or omp's
 * JSONL, and it names each author from the message's role.
 */
export function createCopySourceReader(): CopySourceReader {
  const reader = new TranscriptContentReader();
  return (entries) =>
    entries.map((entry) => {
      const raw = reader.read(entry);
      const author = AUTHOR_BY_ROLE[entry.message.role];
      return author === undefined ? { raw } : { raw, author };
    });
}
