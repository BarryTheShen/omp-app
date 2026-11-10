import { AppFailure } from "@omp-app/contracts";

/**
 * Why a chat could not open, in words a person can act on. A new chat whose omp stopped as it started carries the
 * server's typed reason (`startup`): "Try again" would fail the same way, so the words say what is missing and where to
 * fix it. The app's chats run omp without its terminal, where omp stops when no model is set up; omp's own terminal app
 * (`omp-app tui`) starts anyway and offers /login and /model there. A chat the server no longer has says so. Any other
 * failure is said in its own words.
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
    if (failure.appError.code === "not_found")
      return "Could not open this chat: the app's server no longer has it.";
  }
  return `Could not open this chat: ${failure instanceof Error ? failure.message : String(failure)}`;
}

/** What the person can do about a chat that could not open: open it again, or start a new chat. */
export type OpenFailureAction = "reopen" | "new-chat";

/**
 * A chat the server no longer has, or whose omp stopped as it started, gets New chat: opening it again would fail the
 * same way. Any other failure gets Try again.
 */
export function openFailureAction(failure: unknown): OpenFailureAction {
  if (
    failure instanceof AppFailure &&
    (failure.appError.startup !== undefined || failure.appError.code === "not_found")
  )
    return "new-chat";
  return "reopen";
}

/**
 * The open failed because the link to the app's server dropped or timed out (the client's own failure for its calls):
 * the chat is opened again by itself once the link is back.
 */
export function lostWithTheLink(failure: unknown): boolean {
  return (
    failure instanceof AppFailure &&
    failure.appError.code === "unavailable" &&
    failure.appError.retryable
  );
}

/** The app's server has no open chat by that id: it restarted, and the chat's omp ended with the old server. */
export function notOpenOnServer(failure: unknown): boolean {
  return failure instanceof AppFailure && failure.appError.code === "not_found";
}
