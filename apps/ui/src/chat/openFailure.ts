import { AppFailure } from "@omp-app/contracts";

/**
 * Why a chat could not open, in words a person can act on. A new chat whose omp stopped as it started carries the
 * server's typed reason (`startup`): "Try again" would fail the same way, so the words say what is missing and where to
 * fix it. The app's chats run omp without its terminal, where omp stops when no model is set up; omp's own terminal app
 * (`omp-app tui`) starts anyway and offers /login and /model there. Any other failure is said in its own words.
 */
export function openFailureText(failure: unknown): string {
  if (failure instanceof AppFailure) {
    switch (failure.appError.startup) {
      case "no_model":
        return "Could not open this chat: no model is set up yet. Open a terminal, run “omp-app tui”, and choose a model with /model or sign in with /login there, then start a new chat.";
      case "no_credentials":
        return "Could not open this chat: omp cannot sign in to its model. Open a terminal, run “omp-app tui”, and sign in with /login there, then start a new chat.";
      case "other":
        return "Could not open this chat: omp stopped as it started. Open a terminal and run “omp-app tui” to see why, then start a new chat.";
      case undefined:
        break;
    }
  }
  return `Could not open this chat: ${failure instanceof Error ? failure.message : String(failure)}`;
}
