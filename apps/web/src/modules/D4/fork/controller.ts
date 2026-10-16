import {
  type AppError,
  AppFailure,
  type FolderPath,
  type ThreadId,
  UiRequestId,
} from "@omp-app/contracts";
import type { DialogHost, FocusRestoreHandle } from "@/modules/U4/contract";
import type { ShareImportResultDto } from "../contract";
import { checkShareLink } from "./link";
import type { ShareImportPort } from "./port";

/** Why omp refused the import before any chat was made. */
export type ImportRefusal = "no-folder" | "empty-link" | "bad-link" | "unsupported";
/** Why an import failed for a reason the person can retry or report. */
export type ImportFailure = "unreachable" | "omp-error" | "unexpected";

/**
 * How one import ended. `imported` and `imported-with-notes` both made a new chat and never changed the shared
 * chat; `opened` says whether the new chat is now on screen. Nothing counts as imported until omp's typed result
 * has arrived.
 */
export type ImportOutcome =
  | {
      readonly outcome: "imported";
      readonly result: ShareImportResultDto;
      readonly opened: boolean;
    }
  | {
      readonly outcome: "imported-with-notes";
      readonly result: ShareImportResultDto;
      readonly opened: boolean;
    }
  | { readonly outcome: "not-imported" }
  | { readonly outcome: "refused"; readonly why: ImportRefusal }
  | { readonly outcome: "failed"; readonly why: ImportFailure; readonly error: AppError };

export interface ImportController {
  /**
   * Asks for the link, checks it, asks Confirm, then imports. Nothing reaches omp until the person confirms. A call
   * made while an import runs returns that import, with no second question. It never rejects.
   */
  importShare(): Promise<ImportOutcome>;
}

export interface ImportControllerDeps {
  /** The open chat. Its dialog host shows the questions, and the questions are app-origin: no omp answer is sent. */
  readonly threadId: ThreadId;
  /** Read when the import starts, so the new chat goes in the folder the chat is in at that moment. */
  readonly folder: () => FolderPath | null;
  readonly importPort: ShareImportPort;
  /** Whether omp can import at all: the upstream gate. It is read first, so while it is missing nothing is asked. */
  readonly importAvailable: () => boolean;
  readonly dialogs: DialogHost;
  /** Focus destination supplied by the composer and invoked by U4 after each import dialog closes. */
  readonly restoreFocus: FocusRestoreHandle;
  /** Opens the new chat. A rejection leaves the import done: the outcome says the chat could not be opened. */
  readonly openChat: (threadId: ThreadId) => Promise<void>;
  /** Called once the person has confirmed and the import starts. */
  readonly onImporting?: () => void;
}

let requestSequence = 0;
/** App-origin dialog ids begin with `app-`; one counter keeps them unique across every question. */
function requestId(purpose: string): UiRequestId {
  requestSequence += 1;
  return UiRequestId.parse(`app-import-${purpose}-${requestSequence}`);
}

/** Maps a failure from A1.12 onto one outcome. The server reports the upstream gate as `unavailable` with its capability. */
function fromFailure(error: AppFailure): ImportOutcome {
  const app = error.appError;
  if (app.code === "cancelled") return { outcome: "not-imported" };
  if (app.code === "invalid_args") return { outcome: "refused", why: "bad-link" };
  if (app.capability === "upstream.session-import") {
    return { outcome: "refused", why: "unsupported" };
  }
  if (app.code === "unavailable") return { outcome: "failed", why: "unreachable", error: app };
  if (app.code === "omp_error") return { outcome: "failed", why: "omp-error", error: app };
  return { outcome: "failed", why: "unexpected", error: app };
}

/**
 * The import flow for one chat: the folder check, the link question, the link check, the confirmation, the import,
 * the notes (when any part did not come across), and the new chat. The dialog host owns focus, timeout and
 * cancellation. A new chat exists only once A1.12 returned a result.
 */
export function createImportController(deps: ImportControllerDeps): ImportController {
  let inFlight: Promise<ImportOutcome> | undefined;
  const chat = {
    threadId: deps.threadId,
    origin: "app" as const,
    restoreFocus: deps.restoreFocus,
  };

  async function run(): Promise<ImportOutcome> {
    try {
      if (!deps.importAvailable()) return { outcome: "refused", why: "unsupported" };
      const folder = deps.folder();
      if (folder === null) return { outcome: "refused", why: "no-folder" };
      const typed = await deps.dialogs.open(
        {
          kind: "input",
          id: requestId("link"),
          title: "Import a shared chat",
          placeholder: "Paste the share link, which starts with https://",
        },
        chat,
      );
      if (typed.outcome === "cancelled" || typed.response.kind !== "input") {
        return { outcome: "not-imported" };
      }
      const check = checkShareLink(typed.response.value);
      if (!check.ok) return { outcome: "refused", why: check.why };
      const confirmation = await deps.dialogs.open(
        {
          kind: "confirm",
          id: requestId("confirm"),
          title: "Import this shared chat?",
          message: `omp will try to make a new chat on this computer from the shared chat at ${check.host}. The shared chat itself is not changed.`,
        },
        chat,
      );
      if (confirmation.outcome === "cancelled" || !confirmation.response.confirmed) {
        return { outcome: "not-imported" };
      }
      deps.onImporting?.();
      const result = await deps.importPort.importShare(check.link, folder);
      if (result.artifactWarnings.length > 0) {
        await deps.dialogs.open(
          {
            kind: "editor",
            id: requestId("notes"),
            title: "Not all of the shared chat came across",
            prefill: result.artifactWarnings.join("\n"),
            readOnly: true,
          },
          chat,
        );
      }
      const opened = await deps.openChat(result.threadId).then(
        () => true,
        () => false,
      );
      const notes = result.artifactStatus === "unavailable" || result.artifactWarnings.length > 0;
      return notes
        ? { outcome: "imported-with-notes", result, opened }
        : { outcome: "imported", result, opened };
    } catch (error) {
      if (error instanceof AppFailure) return fromFailure(error);
      return {
        outcome: "failed",
        why: "unexpected",
        error: {
          code: "internal",
          message: "The shared chat could not be imported for an unexpected reason.",
          retryable: false,
        },
      };
    }
  }

  return {
    importShare() {
      if (inFlight === undefined) {
        inFlight = run().finally(() => {
          inFlight = undefined;
        });
      }
      return inFlight;
    },
  };
}
