import type { AppError } from "@omp-app/contracts";

/** What the screen says while no chat is open: its title, the line under it, and the composer's text. */
export interface EmptyStateCopy {
  readonly title: string;
  readonly detail: string;
  /** Replaces the composer's "open a session" text while a New chat opens; null keeps that text. */
  readonly composer: string | null;
}

/**
 * The empty screen's words. A New chat that is opening says omp is starting, not that a folder or a
 * session is needed; a chat that failed to open says why, in the error's own words.
 */
export function emptyStateCopy({
  opening,
  error,
}: {
  readonly opening: boolean;
  readonly error: AppError | null;
}): EmptyStateCopy {
  if (opening) {
    return {
      title: "Opening session…",
      detail: "omp is starting. This can take a few seconds.",
      composer: "Starting a new chat…",
    };
  }
  return {
    title: "Ready when you are",
    detail: error?.message ?? "Choose a workspace folder and start a new session.",
    composer: null,
  };
}
