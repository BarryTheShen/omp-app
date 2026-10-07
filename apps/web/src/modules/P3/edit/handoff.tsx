import { useCallback, useRef } from "react";
import type { EditComposerReplacementRequest, EditComposerSource } from "@/modules/U2/edit";
import { EditComposer } from "@/modules/U2/edit";
import type { BranchMessage, EditSource } from "../contract";

export interface P3EditSource {
  readonly editSource: EditSource;
  readonly composerSource: EditComposerSource;
}

export interface P3EditSelection extends P3EditSource {
  readonly message: BranchMessage;
}

export interface P3EditSubmission {
  readonly selection: P3EditSelection;
  readonly replacement: EditComposerReplacementRequest;
}

export interface P3EditComposerHandoffProps {
  readonly selection: P3EditSelection;
  readonly onSubmitReplacement: (submission: P3EditSubmission) => Promise<void> | void;
  readonly onCancel: () => void;
  /** Moves focus back to the control that opened the handoff; called before `onCancel`. */
  readonly restoreFocus: () => void;
  readonly autoFocus?: boolean;
}

/** U2 owns the editor and its U2.7 hooks; P3 adds the typed run-source context. */
export function P3EditComposerHandoff({
  selection,
  onSubmitReplacement,
  onCancel,
  restoreFocus,
  autoFocus = true,
}: P3EditComposerHandoffProps) {
  const callbacks = useRef({ selection, onSubmitReplacement, onCancel, restoreFocus });
  callbacks.current = { selection, onSubmitReplacement, onCancel, restoreFocus };
  const submitReplacement = useCallback(
    (replacement: EditComposerReplacementRequest) =>
      callbacks.current.onSubmitReplacement({
        selection: callbacks.current.selection,
        replacement,
      }),
    [],
  );
  // Focus moves to the opener before the composer unmounts, so it never falls to the page body.
  const cancel = useCallback(() => {
    callbacks.current.restoreFocus();
    callbacks.current.onCancel();
  }, []);
  return (
    <EditComposer
      key={`${String(selection.editSource.threadId)}:${String(selection.editSource.entryId)}`}
      source={selection.composerSource}
      submitReplacement={submitReplacement}
      onCancel={cancel}
      autoFocus={autoFocus}
    />
  );
}
