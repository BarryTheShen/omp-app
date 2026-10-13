import type { AppError, FolderPath, ThreadId } from "@omp-app/contracts";

/** A chat that did not open because its saved model is gone, and the folder the chat was saved in. */
export interface OpenFailure {
  readonly folder: FolderPath | null;
  readonly threadId: ThreadId;
  readonly error: AppError;
}

/**
 * The failure the empty screen may show for the folder on screen. A failure belongs to the folder its chat was saved
 * in, so another folder's failure shows nothing, even one reported after the folder changed (issue 1316).
 */
export function openFailureIn(
  failure: OpenFailure | null,
  folder: FolderPath | null,
): OpenFailure | null {
  return failure !== null && folder !== null && failure.folder === folder ? failure : null;
}
