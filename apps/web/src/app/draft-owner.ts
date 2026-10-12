import { useEffect, useMemo } from "react";
import type { DraftController } from "@/modules/U2/drafts";
import { useDisposeWhenReplaced } from "@/modules/U4/host";
import { reportClientError } from "./client-errors";

/** Hands a failed draft operation to the debug log, with its cause. */
export function reportDraftFailure(what: string): (error: unknown) => void {
  return (error) =>
    reportClientError({
      kind: "error",
      message: `${what}: ${error instanceof Error ? error.message : "unknown error"}`,
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    });
}

/**
 * Loads the composer's draft when the composer shows it, and disposes it when the composer moves to another draft or
 * unmounts. The dispose is queued through `useDisposeWhenReplaced`, not run in the effect's own cleanup: StrictMode runs
 * that cleanup and then the effect again with the same controller, and a controller disposed there stops saving and
 * stops telling the composer about changes.
 */
export function useComposerDraftOwner(controller: DraftController): void {
  useEffect(() => {
    // A failed load is kept in the debug log: once the composer has gone, nothing else shows it. The text that could
    // not be saved stays in this tab's buffer, so it is restored when the chat opens again.
    controller.load().catch(reportDraftFailure("Loading the draft failed"));
  }, [controller]);
  const owned = useMemo(
    () => ({
      dispose: () =>
        void controller
          .dispose()
          .catch(reportDraftFailure("Saving the draft when its chat closed failed")),
    }),
    [controller],
  );
  useDisposeWhenReplaced(owned);
}
