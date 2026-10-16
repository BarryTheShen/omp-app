import type { AppendMessage } from "@assistant-ui/react";
import type { EntryId } from "@omp-app/contracts";
import { EntryId as EntryIdSchema } from "@omp-app/contracts";
import { promptFromAppend } from "@/modules/R0/runtime";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { asEditFailure, type EditRunResult } from "../contract";
import { runFailure } from "./failure";
import type { P3ThreadHandoff } from "./handoff";
import type { P3EditRun } from "./run";
import { captureP3EditSource, storedEntryId } from "./source";
import type {
  P3FailedState,
  P3RunKind,
  P3RunRecord,
  P3RunReplacement,
  P3RunState,
  P3RunStatus,
  P3SentState,
} from "./status";

export interface P3RunHandlers {
  /** assistant-ui's edit handler: branches from the edited message and sends the replacement on the new chat. */
  readonly onEdit: (message: AppendMessage) => Promise<void>;
  /** assistant-ui's reload handler: asks an answer again on a new branch of the message it answers. */
  readonly onReload: (parentId: string | null, config: unknown) => Promise<void>;
  /** Sends a failed run again: on the new chat when a branch opened, otherwise from the source message. */
  readonly retry: (failure: P3FailedState) => Promise<void>;
}

export interface P3RunHandlerOptions {
  /** The chat these handlers serve. Its source messages are captured from this store only. */
  readonly store: OmpRuntimeStore;
  readonly run: P3EditRun;
  readonly handoff: P3ThreadHandoff;
  readonly status: P3RunStatus;
}

const FALLBACK_MESSAGE = "The message could not be sent. Try again.";
const NOT_SAVED_MESSAGE =
  "This message is not saved in the chat yet. Try again once it has finished.";
const NOT_IN_CHAT_MESSAGE = "That message is no longer in this chat.";

function recordOf(state: P3RunRecord): P3RunRecord {
  return {
    kind: state.kind,
    sourceEntryId: state.sourceEntryId,
    sourceThreadId: state.sourceThreadId,
    replacement: state.replacement,
  };
}

function sentFields(result: EditRunResult): Omit<P3SentState, keyof P3RunRecord | "phase"> {
  return {
    threadId: result.threadId,
    workspaceGuarantee: result.workspaceGuarantee ?? "not-managed",
    externalChanges: result.externalChanges ?? [],
    partialFailure: result.partialFailure ?? null,
  };
}

export function createP3RunHandlers(options: P3RunHandlerOptions): P3RunHandlers {
  const { store, run, handoff, status } = options;

  // Publishes a run's failure. A run started from the editor that omp cancels before a chat opened is a silent no-op:
  // no notice, and the editor keeps the person's text (spec 5.5). Only the run that still owns the status ends silently;
  // a newer run's state, `sending` or later, is left as it is. Any other cancelled run (Try again, regenerate) keeps its
  // failed notice, which holds the text, so the text is never lost without a message.
  const publishFailed = (
    record: P3RunRecord,
    error: unknown,
    sending: P3RunState | null,
    fromEditor: boolean,
  ): void => {
    const failure = asEditFailure(error, FALLBACK_MESSAGE);
    const target = handoff.target;
    const branched = handoff.branched || target !== null;
    if (fromEditor && failure.appError.code === "cancelled" && !branched) {
      if (sending !== null && status.getSnapshot() === sending) status.set({ phase: "idle" });
      return;
    }
    status.set({
      phase: "failed",
      ...recordOf(record),
      branched,
      chatThreadId: target ?? record.sourceThreadId,
      message: failure.appError.code === "internal" ? FALLBACK_MESSAGE : failure.appError.message,
      retryable: failure.appError.retryable,
    });
  };

  // Starts a run from its source message. Nothing it does rejects: every outcome is published.
  const start = async (
    kind: P3RunKind,
    sourceEntryId: EntryId | null,
    replacement: P3RunReplacement | null,
    runConfig: unknown,
    fromEditor: boolean,
  ): Promise<void> => {
    handoff.beginRun();
    let record: P3RunRecord = {
      kind,
      sourceEntryId,
      sourceThreadId: store.getSnapshot().threadId,
      replacement: replacement ?? { text: "", images: [] },
    };
    let sending: P3RunState | null = null;
    try {
      if (sourceEntryId === null) throw runFailure("not_found", NOT_SAVED_MESSAGE, false);
      const source = captureP3EditSource(store, sourceEntryId);
      if (source === null) throw runFailure("not_found", NOT_IN_CHAT_MESSAGE, false);
      // An answer asked again sends the text and images its user message stored.
      const sent: P3RunReplacement = replacement ?? {
        text: source.editSource.originalText,
        images: source.editSource.originalImages,
      };
      record = { ...record, replacement: sent };
      status.set({ phase: "sending", ...record });
      sending = status.getSnapshot();
      const result =
        kind === "edit"
          ? await run.edit({
              source: source.editSource,
              replacementText: sent.text,
              replacementImages: sent.images,
            })
          : await run.reload({ source: source.editSource, runConfig });
      status.set({ phase: "sent", ...record, ...sentFields(result) });
    } catch (error) {
      publishFailed(record, error, sending, fromEditor);
    }
  };

  // Sends a failed run's replacement again on the chat it opened. No new branch is made.
  const resend = async (failure: P3FailedState): Promise<void> => {
    const record = recordOf(failure);
    status.set({ phase: "sending", ...record });
    const sending = status.getSnapshot();
    try {
      const result = await run.resend(record.replacement);
      status.set({ phase: "sent", ...record, ...sentFields(result) });
    } catch (error) {
      publishFailed(record, error, sending, false);
    }
  };

  const onEdit = async (message: AppendMessage): Promise<void> => {
    const prompt = promptFromAppend(message);
    await start(
      "edit",
      EntryIdSchema.safeParse(message.sourceId).data ?? null,
      { text: prompt.text, images: prompt.images ?? [] },
      undefined,
      true,
    );
  };

  const onReload = async (parentId: string | null, config: unknown): Promise<void> => {
    // assistant-ui names the user message an answer belongs to by its row, which is not its entry id.
    const entryId = parentId === null ? null : storedEntryId(store, parentId);
    await start("regenerate", entryId, null, config, false);
  };

  const retry = (failure: P3FailedState): Promise<void> =>
    failure.branched
      ? resend(failure)
      : start(
          failure.kind,
          failure.sourceEntryId,
          failure.kind === "edit" ? failure.replacement : null,
          undefined,
          false,
        );

  return { onEdit, onReload, retry };
}
