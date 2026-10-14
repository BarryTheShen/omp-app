import { asFailure, failure } from "./failure";

/**
 * The open chat as the export reads it. The runtime store holds only the newest window of the chat's history
 * (bounded in bytes), and each older page loads on request, so until those pages are loaded the messages are
 * only the chat's tail.
 */
export interface ChatHistory<M> {
  /** The chat's messages as they are now, oldest first. */
  readonly messages: () => readonly M[];
  /** How many entries of the chat are loaded so far. */
  readonly loadedEntries: () => number;
  /** True while older entries remain that are not loaded. */
  readonly hasOlder: () => boolean;
  /** Loads the page of entries older than the oldest one loaded. */
  readonly loadOlder: () => Promise<void>;
}

/**
 * The whole chat, oldest first: older pages load until the chat has no more. A file says it holds the whole chat,
 * so it is never made from the tail alone. A page that adds no entries while older ones remain would never end,
 * so it stops the export with a plain failure instead.
 */
export async function readWholeChat<M>(
  history: ChatHistory<M>,
  signal?: AbortSignal,
): Promise<readonly M[]> {
  while (history.hasOlder()) {
    if (signal?.aborted === true) throw failure("cancelled", "The export was cancelled.");
    const loaded = history.loadedEntries();
    await asFailure(
      () => history.loadOlder(),
      "The older part of this chat could not be read, so nothing was exported.",
    );
    if (history.loadedEntries() === loaded && history.hasOlder()) {
      throw failure(
        "internal",
        "omp did not return the older part of this chat, so nothing was exported.",
      );
    }
  }
  if (signal?.aborted === true) throw failure("cancelled", "The export was cancelled.");
  return history.messages();
}
