import type { AppError } from "@omp-app/contracts";

/** What the screen says while no chat is open: its title, the line under it, and the composer's text. */
export interface EmptyStateCopy {
  readonly title: string;
  readonly detail: string;
  /** Replaces the composer's "open a session" text while a New chat opens; null keeps that text. */
  readonly composer: string | null;
}

/**
 * Plain words for a chat that omp could not start: what happened, and the next step. They replace omp's own
 * text for a startup failure, which the browser never shows (the server sends a typed reason instead).
 */
function startupDetail(error: AppError): string | null {
  switch (error.startup) {
    case "no_model":
      return "omp stopped because no model is set up. Open a terminal, run `omp`, and sign in or choose a model there, then start a new chat.";
    case "no_credentials":
      return "omp stopped because it cannot sign in to a model. Open a terminal, run `omp`, and sign in or set an API key there, then start a new chat.";
    case "other":
      return "omp stopped before the chat could start. Open a terminal and run `omp` to see what it prints, then start a new chat.";
    case undefined:
      return null;
  }
}

/**
 * The empty screen's words. A New chat that is opening says omp is starting, not that a folder or a
 * session is needed; a chat that failed to open says why: in plain words when omp stopped at start-up, and
 * otherwise in the error's own words.
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
    title: error?.code === "model_unavailable" ? "This chat could not open" : "Ready when you are",
    detail:
      error === null
        ? "Choose a workspace folder and start a new session."
        : (startupDetail(error) ?? error.message),
    composer: null,
  };
}
