import type { EntryId, ThreadId } from "@omp-app/contracts";
import { AppFailure, UiRequestId as UiRequestIdSchema } from "@omp-app/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SelectDialogRequest } from "@/modules/U4/contract/dialog";
import type { DialogHostOpenOptions } from "@/modules/U4/contract/dialog-host";
import type { DialogResultFor } from "@/modules/U4/contract/responses";
import type { BranchMessage, BranchMessageSelectorPort } from "../contract";
import type { P3EditSelection, P3EditSource } from "../edit";

export type P3PreviousMessageSelectorViewModel =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "opening" }
  | { readonly state: "empty" }
  /** The action is hidden: omp lacks `get_branch_messages` or `branch` (AP2, AP6). */
  | { readonly state: "unavailable" }
  | { readonly state: "error"; readonly message: string; readonly retryable: boolean };

export interface P3PreviousMessageDialogHost {
  open(
    request: SelectDialogRequest,
    options: DialogHostOpenOptions,
  ): Promise<DialogResultFor<SelectDialogRequest>>;
}

export interface P3PreviousMessageSelectorActions {
  readonly onOpen: (trigger: HTMLButtonElement) => void;
  readonly onRetry: () => void;
  /** Moves focus back to the trigger; the edit handoff calls it when the user cancels. */
  readonly restoreFocus: () => void;
}

export interface P3PreviousMessageSelectorControllerModel {
  readonly viewModel: P3PreviousMessageSelectorViewModel;
  readonly actions: P3PreviousMessageSelectorActions;
  /** Clears stale selector state and aborts a request when a turn starts. */
  readonly onRunningChange: (running: boolean) => void;
}

export interface P3PreviousMessageSelectorOptions {
  readonly branchMessages: BranchMessageSelectorPort;
  readonly dialogs: P3PreviousMessageDialogHost;
  readonly threadId: ThreadId;
  /** True only when omp's `get_branch_messages` and `branch` commands are both available (AP2). */
  readonly available: boolean;
  /**
   * True for entries on the conversation's current branch (omp's `getBranch()`). The list from
   * `branchMessages` also holds abandoned branches, so composition derives this from the branch
   * repository's head.
   */
  readonly onCurrentBranch: (entryId: EntryId) => boolean;
  /** Resolves U1's complete source, including U2 attachment references, for one stable entry id. */
  readonly resolveSource: (
    message: BranchMessage,
    signal: AbortSignal,
  ) => Promise<P3EditSource | null>;
  readonly onSelect: (selection: P3EditSelection) => Promise<void> | void;
}

interface MessageOption {
  readonly label: string;
  readonly description: string | undefined;
  readonly message: BranchMessage;
}

const LABEL_LIMIT = 60;
const DESCRIPTION_LIMIT = 180;

/** The first `limit` characters, cut back to a word break when one falls in the second half. */
function firstWords(line: string, limit: number): string {
  if (line.length <= limit) return line;
  const head = line.slice(0, limit);
  const wordEnd = head.lastIndexOf(" ");
  const cut = wordEnd > limit / 2 ? head.slice(0, wordEnd) : head;
  return `${cut.trimEnd()}…`;
}

/**
 * U4 answers with the label text, so each label must name one message: a repeated label gets
 * " (2)", " (3)" and so on, counted from the newest message.
 */
function messageOptions(messages: readonly BranchMessage[]): readonly MessageOption[] {
  const labels = new Set<string>();
  const repeats = new Map<string, number>();
  return messages.map((message) => {
    // The words on one line, so a line break inside the message cannot split a row.
    const line = message.text.replace(/\s+/g, " ").trim();
    const base = line.length === 0 ? "Message without text" : firstWords(line, LABEL_LIMIT);
    let repeat = repeats.get(base) ?? 1;
    let label = base;
    while (labels.has(label)) {
      repeat += 1;
      label = `${base} (${repeat})`;
    }
    repeats.set(base, repeat);
    labels.add(label);
    // The detail appears only when the label leaves part of the message out.
    const description = line.length > LABEL_LIMIT ? firstWords(line, DESCRIPTION_LIMIT) : undefined;
    return { label, description, message };
  });
}

function visibleError(
  error: unknown,
  fallbackMessage: string,
): { readonly message: string; readonly retryable: boolean } {
  if (error instanceof AppFailure) {
    return {
      message: error.appError.code === "internal" ? fallbackMessage : error.appError.message,
      retryable: error.appError.retryable,
    };
  }
  return { message: fallbackMessage, retryable: true };
}

function validateSelection(
  threadId: ThreadId,
  message: BranchMessage,
  source: P3EditSource,
): P3EditSelection | null {
  if (
    source.editSource.threadId !== threadId ||
    source.editSource.entryId !== message.entryId ||
    source.composerSource.sourceMessageId !== String(message.entryId)
  ) {
    return null;
  }
  return { message, ...source };
}

/** Loads P3's typed user-message list and presents it through U4's app-owned select dialog. */
export function useP3PreviousMessageSelectorController(
  options: P3PreviousMessageSelectorOptions,
): P3PreviousMessageSelectorControllerModel {
  const [viewModel, setViewModel] = useState<P3PreviousMessageSelectorViewModel>({ state: "idle" });
  const optionsRef = useRef(options);
  const threadIdRef = useRef(options.threadId);
  const activeRequest = useRef<AbortController | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const runningRef = useRef(false);
  optionsRef.current = options;

  useLayoutEffect(() => {
    if (threadIdRef.current === options.threadId) return;
    threadIdRef.current = options.threadId;
    activeRequest.current?.abort();
    activeRequest.current = null;
    triggerRef.current = null;
    setViewModel({ state: "idle" });
  }, [options.threadId]);

  useEffect(
    () => () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    },
    [],
  );

  const onRunningChange = useCallback((running: boolean) => {
    const wasRunning = runningRef.current;
    runningRef.current = running;
    if (!running || wasRunning) return;

    activeRequest.current?.abort();
    activeRequest.current = null;
    triggerRef.current = null;
    setViewModel({ state: "idle" });
  }, []);

  const restoreFocus = useCallback(() => {
    const trigger = triggerRef.current;
    if (trigger?.isConnected) trigger.focus();
  }, []);

  const onOpen = useCallback(async (trigger: HTMLButtonElement): Promise<void> => {
    if (runningRef.current || activeRequest.current !== null || !optionsRef.current.available)
      return;
    triggerRef.current = trigger;
    const requestController = new AbortController();
    activeRequest.current = requestController;
    const requestThreadId = optionsRef.current.threadId;
    setViewModel({ state: "loading" });

    let failureMessage = "Earlier messages could not be loaded.";
    try {
      const listed = await optionsRef.current.branchMessages.list(
        requestThreadId,
        requestController.signal,
      );
      if (requestController.signal.aborted || optionsRef.current.threadId !== requestThreadId)
        return;
      // omp lists every user message in the session file. The picker shows the current branch,
      // newest first, the same rows omp's own selector walks.
      const messages = listed
        .filter((message) => optionsRef.current.onCurrentBranch(message.entryId))
        .reverse();
      if (messages.length === 0) {
        setViewModel({ state: "empty" });
        return;
      }

      const rows = messageOptions(messages);
      const messageByLabel = new Map(rows.map((row) => [row.label, row.message]));
      const request: SelectDialogRequest = {
        kind: "select",
        id: UiRequestIdSchema.parse(`app-p3-previous-message-${crypto.randomUUID()}`),
        title: "Edit an earlier message",
        options: rows.map((row) => row.label),
        optionDetails: rows.map(({ description }) =>
          description === undefined ? {} : { description },
        ),
      };
      failureMessage = "Earlier messages could not be opened.";
      setViewModel({ state: "idle" });
      // The modal's FocusScope returns focus to the element focused when it mounts, so the trigger
      // takes focus first. Passing restoreFocus would name the same element now that the dialog host
      // calls it after the dialog has unmounted (issue 756); the trigger focus stays so that the return
      // does not depend on that order.
      trigger.focus();
      const dialog = await optionsRef.current.dialogs.open(request, {
        threadId: requestThreadId,
        origin: "app",
        signal: requestController.signal,
      });
      if (requestController.signal.aborted || optionsRef.current.threadId !== requestThreadId)
        return;
      if (dialog.outcome === "cancelled") {
        setViewModel({ state: "idle" });
        return;
      }

      const message = messageByLabel.get(dialog.response.value);
      if (!message) {
        throw new AppFailure({
          code: "conflict",
          message: "The selected message is no longer available. Choose another message.",
          retryable: true,
        });
      }
      // Busy until onSelect settles: resolving the source can wait on U2 attachment reads.
      setViewModel({ state: "opening" });
      failureMessage = "The selected message could not be opened.";
      const source = await optionsRef.current.resolveSource(message, requestController.signal);
      if (requestController.signal.aborted || optionsRef.current.threadId !== requestThreadId)
        return;
      const selection = source ? validateSelection(requestThreadId, message, source) : null;
      if (!selection) {
        throw new AppFailure({
          code: "conflict",
          message: "The selected message changed. Choose it again.",
          retryable: true,
        });
      }
      await optionsRef.current.onSelect(selection);
      if (!requestController.signal.aborted) setViewModel({ state: "idle" });
    } catch (error) {
      if (requestController.signal.aborted || optionsRef.current.threadId !== requestThreadId)
        return;
      if (error instanceof AppFailure && error.appError.code === "cancelled") {
        setViewModel({ state: "idle" });
        return;
      }
      setViewModel({ state: "error", ...visibleError(error, failureMessage) });
    } finally {
      if (activeRequest.current === requestController) activeRequest.current = null;
    }
  }, []);

  const onRetry = useCallback(() => {
    if (runningRef.current) return;
    const trigger = triggerRef.current;
    if (!trigger?.isConnected) return;
    // "Try again" leaves the page while the list loads, so focus moves to the trigger first.
    trigger.focus();
    void onOpen(trigger);
  }, [onOpen]);

  // Without both commands the action is not shown at all (AP2, AP6): a person on an omp that cannot
  // edit an earlier message has nothing to act on, and the app never offers what omp cannot do.
  const visible: P3PreviousMessageSelectorViewModel = options.available
    ? viewModel
    : { state: "unavailable" };
  return { viewModel: visible, actions: { onOpen, onRetry, restoreFocus }, onRunningChange };
}
