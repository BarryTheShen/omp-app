import type { ThreadMessageLike } from "@assistant-ui/react";
import type { SessionFilePath } from "@omp-app/contracts";
import type { SubagentTranscriptPage } from "@/modules/P1/contract";
import { toThreadMessages } from "./messages";

/**
 * What the tail has read from one session file so far. Immutable: each applied page returns a new
 * value, or the same value when the page changed nothing.
 */
export interface TranscriptTailState {
  /** The file the cursor belongs to; undefined until the first page is applied. */
  readonly sessionFile: SessionFilePath | undefined;
  /** omp's `nextByte` after the last complete record that was applied. */
  readonly cursor: number;
  /** Raw messages applied so far, hidden ones included, so the next message's position is known. */
  readonly rawCount: number;
  /** Converted messages, in transcript order. */
  readonly messages: readonly ThreadMessageLike[];
  /** Counts the pages that changed the state; zero means nothing has been read yet. */
  readonly revision: number;
}

export const EMPTY_TRANSCRIPT_TAIL: TranscriptTailState = Object.freeze({
  sessionFile: undefined,
  cursor: 0,
  rawCount: 0,
  messages: Object.freeze([]),
  revision: 0,
});

/**
 * The byte offset to ask omp for. A fresh tail reads from zero. So does a worker whose recorded file
 * moved, because the new file is a different transcript. Otherwise the tail continues from its cursor.
 */
export function requestOffset(
  state: TranscriptTailState,
  recordedFile: SessionFilePath | undefined,
): number {
  if (state.sessionFile === undefined) return 0;
  if (recordedFile !== undefined && recordedFile !== state.sessionFile) return 0;
  return state.cursor;
}

/**
 * Applies one page that was read from `requestedFrom`:
 * - a continuation (the same file, read from the cursor) appends its new messages;
 * - a page that starts at byte zero replaces the transcript: the first read, a reset that omp reports
 *   (the file shrank or was replaced), or a file change;
 * - any other page cannot be placed, so the cursor is dropped and the next read starts at zero. The
 *   messages already shown stay until that read replaces them: nothing is lost and nothing flickers.
 */
export function applyTranscriptPage(
  state: TranscriptTailState,
  page: SubagentTranscriptPage,
  requestedFrom: number,
): TranscriptTailState {
  const continuation =
    !page.reset &&
    state.sessionFile !== undefined &&
    page.sessionFile === state.sessionFile &&
    requestedFrom === state.cursor &&
    page.fromByte === requestedFrom;
  if (continuation) {
    if (page.messages.length === 0 && page.nextByte === state.cursor) return state;
    return {
      sessionFile: state.sessionFile,
      cursor: page.nextByte,
      rawCount: state.rawCount + page.messages.length,
      messages: [...state.messages, ...toThreadMessages(page.messages, state.rawCount)],
      revision: state.revision + 1,
    };
  }
  if (page.fromByte === 0) {
    return {
      sessionFile: page.sessionFile,
      cursor: page.nextByte,
      rawCount: page.messages.length,
      messages: toThreadMessages(page.messages, 0),
      revision: state.revision + 1,
    };
  }
  return { ...state, sessionFile: undefined, cursor: 0, rawCount: 0, revision: state.revision + 1 };
}
