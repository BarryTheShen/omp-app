import { type AppError, AppFailure, type ThreadId, UiRequestId } from "@omp-app/contracts";
import type { DialogHost } from "@/modules/U4/contract";
import type { ClipboardPort, SharePort, ShareResult } from "../contract";
import { describeShareConfirmation, type ShareSettings } from "./confirm";

/**
 * How one share ended. Nothing counts as shared until omp's typed result has arrived, and the link is reported as
 * copied only after the clipboard accepted it.
 */
export type ShareOutcome =
  | { readonly outcome: "copied"; readonly result: ShareResult }
  | { readonly outcome: "shown-for-manual-copy"; readonly result: ShareResult }
  | { readonly outcome: "link-not-copied"; readonly result: ShareResult }
  | { readonly outcome: "not-shared" }
  | { readonly outcome: "failed"; readonly error: AppError };

export interface ShareController {
  /**
   * Asks first: nothing reaches omp or a share server unless the person answers Confirm. A call made while a share
   * is running returns that share, with no second question. It never rejects.
   */
  share(): Promise<ShareOutcome>;
}

export interface ShareControllerDeps {
  readonly threadId: ThreadId;
  readonly sharePort: SharePort;
  /** The open chat's dialog host. The questions are app-origin, so no omp answer is sent. */
  readonly dialogs: DialogHost;
  readonly clipboard: ClipboardPort;
  /** The settings in force now. A rejection stops the share before any question is asked. */
  readonly settings: () => Promise<ShareSettings>;
  /** Called once the person has confirmed and the upload starts. */
  readonly onUploading?: () => void;
}

const COPY_LINK = "Copy the link";
const CLOSE = "Close without copying";

const UNEXPECTED: AppError = {
  code: "internal",
  message: "Sharing did not finish for an unexpected reason.",
  retryable: false,
};

let requestSequence = 0;
/** App-origin dialog ids begin with `app-`; one counter keeps them unique across every question. */
function requestId(purpose: string): UiRequestId {
  requestSequence += 1;
  return UiRequestId.parse(`app-share-${purpose}-${requestSequence}`);
}

/** The result's link, with the gist and the trimming note when omp reported them. */
function linkNote(result: ShareResult): string {
  const parts = [result.url];
  if (result.gistUrl !== undefined) parts.push(`Secret GitHub gist: ${result.gistUrl}`);
  if (result.truncated) parts.push("omp trimmed large content to fit the share size limit.");
  return parts.join(" ");
}

/**
 * The share flow for one chat: the question, then the upload, then the link. The dialog host owns focus, timeout
 * and cancellation, and omp's typed result is the only source of a link. There is no lifetime to dispose: a chat
 * that is replaced cancels its open question through the dialog host.
 */
export function createShareController(deps: ShareControllerDeps): ShareController {
  let inFlight: Promise<ShareOutcome> | undefined;
  const chat = { threadId: deps.threadId, origin: "app" as const };

  async function run(): Promise<ShareOutcome> {
    try {
      const confirmation = describeShareConfirmation(await deps.settings());
      const answer = await deps.dialogs.open(
        {
          kind: "confirm",
          id: requestId("confirm"),
          title: confirmation.title,
          message: confirmation.message,
        },
        chat,
      );
      if (answer.outcome === "cancelled" || !answer.response.confirmed) {
        return { outcome: "not-shared" };
      }
      deps.onUploading?.();
      const result = await deps.sharePort.createShare(deps.threadId);
      return await offerCopy(result);
    } catch (error) {
      if (error instanceof AppFailure && error.appError.code === "cancelled") {
        return { outcome: "not-shared" };
      }
      return {
        outcome: "failed",
        error: error instanceof AppFailure ? error.appError : UNEXPECTED,
      };
    }
  }

  async function offerCopy(result: ShareResult): Promise<ShareOutcome> {
    const choice = await deps.dialogs.open(
      {
        kind: "select",
        id: requestId("result"),
        title: "Share link ready",
        options: [COPY_LINK, CLOSE],
        optionDetails: [
          { description: linkNote(result) },
          { description: "The link is not copied. Share again to make a new link." },
        ],
      },
      chat,
    );
    if (choice.outcome === "cancelled" || choice.response.value !== COPY_LINK) {
      return { outcome: "link-not-copied", result };
    }
    try {
      await deps.clipboard.writeText(result.url);
      return { outcome: "copied", result };
    } catch {
      // A refused clipboard is a recovery, not a success: the link is shown so it can be copied by hand. The text is
      // read-only: the dialog offers only Done, and nothing it shows is saved.
      await deps.dialogs.open(
        {
          kind: "editor",
          id: requestId("manual"),
          title: "Copy this link by hand",
          prefill: result.url,
          readOnly: true,
        },
        chat,
      );
      return { outcome: "shown-for-manual-copy", result };
    }
  }

  return {
    share() {
      if (inFlight === undefined) {
        inFlight = run().finally(() => {
          inFlight = undefined;
        });
      }
      return inFlight;
    },
  };
}
