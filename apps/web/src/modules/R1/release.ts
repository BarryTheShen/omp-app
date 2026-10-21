import type { ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";

/** What the browser can call to let go of a chat it opened on the server. */
export type CloseThread = (args: { readonly threadId: ThreadId }) => Promise<unknown>;

/**
 * Failures that mean there is nothing left to release: the server forgot the chat (it restarted, or
 * stopped an idle omp), the connection is gone or the client was shut down, or omp has exited or is
 * slow to answer. By the time the server answers it has already updated what matters.
 */
const NOTHING_HELD = ["not_found", "unavailable", "cancelled", "omp_exited", "timeout"];

/**
 * The server refused this page's launch link or token. A refused socket never gets a server session, so it holds no chat
 * there; the client reports the refusal with these messages (packages/client/src/client.ts).
 */
const LAUNCH_REFUSED = ["Launch link has expired", "Launch token is not valid"];

/**
 * Tells the server this view of a chat is gone, so an omp nobody watches can be stopped (each holds
 * about 380 MB while idle). Best effort: it never throws, and only a failure that points at a bug is
 * reported.
 */
export async function releaseThread(close: CloseThread, threadId: ThreadId): Promise<void> {
  try {
    await close({ threadId });
  } catch (error) {
    const appError = error instanceof AppFailure ? error.appError : undefined;
    const code = appError?.code ?? "internal";
    if (NOTHING_HELD.includes(code)) return;
    if (code === "permission" && LAUNCH_REFUSED.includes(appError?.message ?? "")) return;
    console.error("[omp-app] could not let go of a chat on the server", error);
  }
}
