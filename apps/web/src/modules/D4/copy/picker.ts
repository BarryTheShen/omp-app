import { AppFailure, type ThreadId, UiRequestId } from "@omp-app/contracts";
import type { DialogHost, DialogHostOpenOptions } from "@/modules/U4/contract";
import type { TranscriptActionPort, TranscriptCopyTargetOption } from "../contract";
import type { CopyPickerOutcome } from "./outcome";
import { textForTarget } from "./text";

const DOWNLOAD = "Download it as a file";
const SHOW_BY_HAND = "Show the text to copy by hand";

/** App-origin dialog ids begin with `app-`. One counter keeps them unique across every picker. */
let requestSequence = 0;
function requestId(purpose: string): UiRequestId {
  requestSequence += 1;
  return UiRequestId.parse(`app-copy-${purpose}-${requestSequence}`);
}

export interface CopyPickerDeps {
  readonly threadId: ThreadId;
  /** U4's dialog host, injected. The picker opens app-origin dialogs only, so no omp answer is sent. */
  readonly dialogs: DialogHost;
  readonly actions: TranscriptActionPort;
  /** Saves text as a file in the browser. Injected, so D4 never touches the DOM. */
  readonly download: (fileName: string, text: string) => void;
}

export interface CopyPickerRunOptions {
  readonly signal?: AbortSignal;
}

export interface CopyPicker {
  /**
   * Offers every copy target in the chat, copies the one the user picks and reports what happened. A
   * clipboard refusal leads to a download or a by-hand view, chosen by the user. Nothing is reported as
   * copied until the clipboard port has accepted the text.
   *
   * Focus: each dialog returns focus to the element focused when it opened, once it has closed. A
   * clipboard recovery is a second dialog, and after two dialogs focus can end on the page itself, so the
   * caller returns focus to its own control when this settles, from an effect after the close commits.
   */
  run(options?: CopyPickerRunOptions): Promise<CopyPickerOutcome>;
}

export function createCopyPicker(deps: CopyPickerDeps): CopyPicker {
  return {
    async run(options = {}) {
      const dialog: DialogHostOpenOptions = {
        threadId: deps.threadId,
        origin: "app",
        signal: options.signal,
      };
      try {
        const targets = await deps.actions.getCopyTargets(deps.threadId, options.signal);
        if (targets.length === 0) return { outcome: "nothing-to-copy" };
        const chosen = await deps.dialogs.open(
          {
            kind: "select",
            id: requestId("pick"),
            title: "Copy from this chat",
            options: targets.map((target) => target.label),
            optionDetails: targets.map((target) => ({ description: target.preview })),
          },
          dialog,
        );
        if (chosen.outcome === "cancelled") return { outcome: "cancelled" };
        const option = targets.find((target) => target.label === chosen.response.value);
        if (option === undefined) {
          return {
            outcome: "not-copied",
            reason: "That copy target is no longer in this chat.",
          };
        }
        return await copyOption(option, dialog);
      } catch (error) {
        return failedOutcome(error);
      }
    },
  };

  async function copyOption(
    option: TranscriptCopyTargetOption,
    dialog: DialogHostOpenOptions,
  ): Promise<CopyPickerOutcome> {
    try {
      const { chars } = await deps.actions.copy(option.target, dialog.signal);
      return { outcome: "copied", label: option.label, chars };
    } catch (error) {
      if (!isPermissionDenial(error)) throw error;
      return recover(option, dialog);
    }
  }

  async function recover(
    option: TranscriptCopyTargetOption,
    dialog: DialogHostOpenOptions,
  ): Promise<CopyPickerOutcome> {
    const choice = await deps.dialogs.open(
      {
        kind: "select",
        id: requestId("recover"),
        title: "The clipboard refused the copy",
        options: [DOWNLOAD, SHOW_BY_HAND],
        optionDetails: [
          { description: "Saves the exact text as a file on this computer." },
          { description: "Opens the exact text so you can select it and copy it yourself." },
        ],
      },
      dialog,
    );
    if (choice.outcome === "cancelled") {
      return {
        outcome: "not-copied",
        reason: "The clipboard refused the copy, so nothing was saved.",
      };
    }
    const text = textForTarget(
      option.target,
      await deps.actions.readParts(option.target, dialog.signal),
    );
    if (choice.response.value === SHOW_BY_HAND) {
      await deps.dialogs.open(
        {
          kind: "editor",
          id: requestId("show"),
          title: `Copy "${option.label}" by hand`,
          prefill: text,
        },
        dialog,
      );
      return { outcome: "shown-for-manual-copy", label: option.label, chars: text.length };
    }
    const fileName = fileNameFor(option.label);
    deps.download(fileName, text);
    return { outcome: "download-started", label: option.label, fileName, chars: text.length };
  }
}

function isPermissionDenial(error: unknown): boolean {
  return error instanceof AppFailure && error.appError.code === "permission";
}

function failedOutcome(error: unknown): CopyPickerOutcome {
  if (error instanceof AppFailure && error.appError.code === "cancelled") {
    return { outcome: "cancelled" };
  }
  return {
    outcome: "not-copied",
    reason:
      error instanceof AppFailure
        ? error.appError.message
        : "The copy failed for an unexpected reason.",
  };
}

/** A file name from the label: "Code block 1 in message 2" becomes "code-block-1-in-message-2.txt". */
function fileNameFor(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug === "" ? "copy" : slug}.txt`;
}
