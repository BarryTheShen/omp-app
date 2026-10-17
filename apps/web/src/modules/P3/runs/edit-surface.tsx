import { useAui } from "@assistant-ui/react";
import type { EntryId, ThreadId } from "@omp-app/contracts";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import type { EditComposerReplacementRequest } from "@/modules/U2/edit";
import { P3EditComposerHandoff, type P3EditSelection, type P3EditSubmission } from "../edit";
import { CANCELLED_BRANCH_MESSAGE, runFailure } from "./failure";
import type { P3Runs } from "./runs";
import { captureP3EditSource, isImageContent } from "./source";
import type { P3RunState } from "./status";

/** The message being edited, and the row button that opened the editor, which focus returns to on cancel. */
export interface P3EditTarget {
  readonly entryId: EntryId;
  readonly trigger: HTMLButtonElement;
}

export interface P3EditSurfaceProps {
  readonly store: OmpRuntimeStore;
  /** The run status the editor follows: an edit sent or failed ends the editor, and a cancelled branch keeps its text. */
  readonly runs: P3Runs;
  readonly target: P3EditTarget | null;
  /** Closes the editor: when the person cancels it, and once the edit it submitted has been sent or has failed. */
  readonly onClose: () => void;
}

/** A submitted edit the editor waits on: its message, the chat it was sent from, the status it started from, and its text. */
interface PendingEdit {
  readonly target: P3EditTarget;
  readonly threadId: ThreadId;
  readonly from: P3RunState;
  readonly replacement: EditComposerReplacementRequest;
  readonly settle: () => void;
}

/** A replacement image as the runtime's append carries it: an image part with its data URL. */
function imagePart(image: unknown): { readonly type: "image"; readonly image: string } {
  if (isImageContent(image)) {
    return { type: "image", image: `data:${image.mimeType};base64,${image.data}` };
  }
  if (
    typeof image === "object" &&
    image !== null &&
    "type" in image &&
    image.type === "image" &&
    "image" in image &&
    typeof image.image === "string"
  ) {
    return { type: "image", image: image.image };
  }
  throw runFailure("invalid_args", "An attached image could not be read. Attach it again.", false);
}

/** The append that edits `entryId`: the replacement text, its images, and its attachment refs. */
function editAppend(entryId: EntryId, replacement: EditComposerReplacementRequest) {
  return {
    role: "user" as const,
    sourceId: String(entryId),
    content: [
      ...(replacement.text.length > 0 ? [{ type: "text" as const, text: replacement.text }] : []),
      ...replacement.images.map(imagePart),
    ],
    attachments: replacement.attachmentRefs.map((ref) => ({
      id: ref.id,
      type: "file" as const,
      name: ref.name,
      contentType: ref.mediaType,
      content: [],
      status: { type: "complete" as const },
    })),
  };
}

/**
 * The composer-footer surface that edits an earlier message: U2's composer, loaded with the message's exact
 * text and images. Submitting hands the edit to the runtime as an append with the message as its source,
 * which R0 receives through its edit handler. The editor stays open while the edit runs: it is inert while the
 * edit is sent, closes once the edit is sent or has failed, and a cancelled branch leaves it open with the
 * person's text, and no notice.
 */
export function P3EditSurface({ store, runs, target, onClose }: P3EditSurfaceProps) {
  const aui = useAui();
  const entryId = target?.entryId ?? null;
  const selection = useMemo<P3EditSelection | null>(() => {
    if (entryId === null) return null;
    const source = captureP3EditSource(store, entryId);
    if (source === null) return null;
    return { message: { entryId, text: source.editSource.originalText }, ...source };
  }, [entryId, store]);
  const state = useSyncExternalStore(
    runs.status.subscribe,
    runs.status.getSnapshot,
    runs.status.getSnapshot,
  );
  const pending = useRef<PendingEdit | null>(null);
  // A cancelled edit's text, by message, until that message's editor closes: the editor shows it again.
  const held = useRef(new Map<EntryId, EditComposerReplacementRequest>());
  // The message whose sent edit is waiting: its composer is inert, so its Cancel and its text cannot be reached.
  const [sendingEntry, setSendingEntry] = useState<EntryId | null>(null);
  // Bumped to remount the composer with the held text, when the editor the text belongs to is on screen.
  const [remount, setRemount] = useState(0);
  // The message the editor showed last: when the editor closes, the text held for that message is dropped.
  const lastEntry = useRef<EntryId | null>(null);

  useEffect(() => {
    if (entryId !== null) {
      lastEntry.current = entryId;
      return;
    }
    if (lastEntry.current !== null) held.current.delete(lastEntry.current);
    lastEntry.current = null;
  }, [entryId]);

  useEffect(() => {
    const current = pending.current;
    if (current === null || state === current.from) return;
    // The run this state belongs to: an idle state is a cancelled run, which has no entry.
    const runEntryId = state.phase === "idle" ? null : state.sourceEntryId;
    if (runEntryId === current.target.entryId && state.phase === "sending") return;
    pending.current = null;
    setSendingEntry(null);
    current.settle();
    const onScreen = target !== null && target.entryId === current.target.entryId;
    if (
      runEntryId === current.target.entryId &&
      (state.phase === "sent" || state.phase === "failed")
    ) {
      // Sent, or failed: the editor closes, and a failure's notice keeps the text. An editor the person opened on
      // another message since is not closed.
      if (onScreen) onClose();
      return;
    }
    if (state.phase === "idle" && !onScreen) {
      // omp cancelled the branch, and the editor the text was sent from is no longer on screen: the text goes to a
      // notice, so it is not lost. The edit was not sent, so the notice is the only place the text shows.
      runs.status.set({
        phase: "failed",
        kind: "edit",
        sourceEntryId: current.target.entryId,
        sourceThreadId: current.threadId,
        replacement: { text: current.replacement.text, images: current.replacement.images },
        branched: false,
        chatThreadId: current.threadId,
        message: CANCELLED_BRANCH_MESSAGE,
        retryable: false,
      });
      return;
    }
    // A cancelled branch keeps the editor's text with no notice, and another run taking the status releases the
    // editor the same way: the edit was not sent by it. Only the editor the text belongs to is remounted, so another
    // message's editor keeps what the person typed in it.
    held.current.set(current.target.entryId, current.replacement);
    if (onScreen) setRemount((generation) => generation + 1);
  }, [state, onClose, runs, target]);

  if (target === null) return null;
  // The editor closes when its edit is sent; P3's notice owns the text while the new chat is pending.
  const restoreFocus = (): void => {
    if (pending.current !== null) return;
    if (target.trigger.isConnected) target.trigger.focus();
  };
  const cancel = (): void => {
    if (pending.current === null) onClose();
  };
  const submit = (submission: P3EditSubmission): Promise<void> => {
    // Built before the editor is held: a refused image keeps the editor and the text open.
    const append = editAppend(submission.selection.editSource.entryId, submission.replacement);
    // Another message's editor can submit while this edit is sent: that submit is refused, and its text stays.
    if (pending.current !== null) {
      throw runFailure(
        "conflict",
        "Another edit is still being sent. Try again once it has finished.",
        true,
      );
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    pending.current = {
      target,
      threadId: store.getSnapshot().threadId,
      from: runs.status.getSnapshot(),
      replacement: submission.replacement,
      settle: () => resolve(),
    };
    held.current.delete(target.entryId);
    setSendingEntry(target.entryId);
    try {
      aui.thread.append(append);
    } catch (error) {
      pending.current = null;
      setSendingEntry(null);
      resolve();
      throw error;
    }
    return promise;
  };

  if (selection === null) {
    return (
      <section
        aria-label="Editing an earlier message"
        className="flex min-w-0 flex-col gap-2 text-sm"
        data-slot="p3-edit-surface"
      >
        <p className="text-danger" role="alert">
          That message is no longer in this chat.
        </p>
        <div>
          <Button
            onClick={() => {
              restoreFocus();
              onClose();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Close
          </Button>
        </div>
      </section>
    );
  }
  // The text the composer shows: the text a sent edit is waiting with, or the text a cancelled edit held for this
  // message. Otherwise it is the message's own text, which is not what the person sent.
  const waiting =
    pending.current !== null && pending.current.target.entryId === target.entryId
      ? pending.current.replacement
      : undefined;
  const heldText = waiting ?? held.current.get(target.entryId);
  const shown: P3EditSelection =
    heldText === undefined
      ? selection
      : {
          ...selection,
          composerSource: {
            ...selection.composerSource,
            text: heldText.text,
            images: heldText.images,
            attachmentRefs: heldText.attachmentRefs,
          },
        };
  return (
    <section
      aria-label="Editing an earlier message"
      className="flex min-w-0 flex-col gap-2"
      data-slot="p3-edit-surface"
    >
      <p className="text-muted-foreground text-sm">Editing an earlier message</p>
      <div inert={sendingEntry === target.entryId ? true : undefined}>
        <P3EditComposerHandoff
          key={remount}
          onCancel={cancel}
          onSubmitReplacement={submit}
          restoreFocus={restoreFocus}
          selection={shown}
        />
      </div>
    </section>
  );
}
