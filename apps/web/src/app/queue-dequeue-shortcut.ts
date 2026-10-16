import { AppFailure } from "@omp-app/contracts";
import { useEffect } from "react";
import { dequeueToEdit, type QueueAdapterController } from "@/modules/P6";
import { P6_DEQUEUE_SHORTCUT_ID } from "@/modules/P6/shortcuts/descriptors";
import type { DraftRestoreRequest } from "@/modules/U2/contract";
import { useShortcutRegistry, useShortcutScope } from "@/shortcuts";
import type { ShortcutRegistry } from "@/shortcuts/registry";

/** What Alt+Up says, in plain English. */
export const QUEUE_DEQUEUE_MESSAGES = {
  restored: "Brought the last queued message back into the message box.",
  nothingQueued: "No queued message to bring back.",
  alreadySent: "That message is already part of omp's reply, so it cannot be brought back.",
  boxHasText: "The message box already has text. Clear it, then press Alt+Up again.",
  failed: "The queued message could not be brought back. Try again.",
} as const;

export interface QueueDequeueShortcutOptions {
  readonly registry: ShortcutRegistry;
  readonly queue: QueueAdapterController;
  /** The composer's draft as it is now: its text and its attachments. */
  readonly draft: () => DraftRestoreRequest;
  /** Puts the restored message in the message box. */
  readonly restore: (request: DraftRestoreRequest) => void;
  /** Says what happened, in plain English. */
  readonly notify: (message: string) => void;
  /** Says why nothing moved, in plain English. */
  readonly fail: (message: string) => void;
}

/**
 * Alt+Up takes the most recent queued message back into the message box, as omp does: a steering message
 * first, then a follow-up. The leading steering messages omp already sent into its reply cannot be taken back,
 * so they are skipped. If the box already has text, nothing moves and the notice asks for it to be cleared.
 * A failure while the message is taken back, such as its leaving the queue first, is said with `fail`.
 */
export function registerQueueDequeueShortcut({
  registry,
  queue,
  draft,
  restore,
  notify,
  fail,
}: QueueDequeueShortcutOptions): () => void {
  return registry.registerAction(P6_DEQUEUE_SHORTCUT_ID, async () => {
    const snapshot = queue.getSnapshot();
    const takeable = snapshot.steerItems.slice(snapshot.liveSteered);
    const last = takeable.at(-1) ?? snapshot.items.at(-1);
    if (last === undefined) {
      notify(
        snapshot.steerItems.length === 0
          ? QUEUE_DEQUEUE_MESSAGES.nothingQueued
          : QUEUE_DEQUEUE_MESSAGES.alreadySent,
      );
      return;
    }
    const current = draft();
    if (current.text.length > 0 || current.attachmentRefs.length > 0) {
      fail(QUEUE_DEQUEUE_MESSAGES.boxHasText);
      return;
    }
    try {
      await dequeueToEdit(queue, last.id, { getDraft: draft, restoreDraft: restore });
    } catch (error: unknown) {
      // dequeueToEdit throws when the message has left the queue since the check above,
      // and when the box cannot take the text back.
      fail(error instanceof AppFailure ? error.appError.message : QUEUE_DEQUEUE_MESSAGES.failed);
      return;
    }
    notify(QUEUE_DEQUEUE_MESSAGES.restored);
  });
}

/**
 * Keeps Alt+Up registered while the open chat is mounted. It mounts the composer scope, where the binding
 * lives; the other composer-scope bindings have no action yet, so they do nothing here.
 */
export function useQueueDequeueShortcut(
  options: Omit<QueueDequeueShortcutOptions, "registry">,
): void {
  const registry = useShortcutRegistry();
  useShortcutScope("composer");
  const { queue, draft, restore, notify, fail } = options;
  useEffect(
    () => registerQueueDequeueShortcut({ registry, queue, draft, restore, notify, fail }),
    [draft, fail, notify, queue, registry, restore],
  );
}
