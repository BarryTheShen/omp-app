import type { AttachmentRef } from "@omp-app/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { AttachmentManager } from "../attachments";
import type { DraftController } from "./drafts";

/** The composer's text, as the draft binding sets it. */
interface ComposerTextTarget {
  setText(text: string): void;
}

interface UseComposerDraftOptions {
  /** The controller that holds the chat's draft right now. */
  readonly controller: DraftController;
  /**
   * The chat the draft belongs to (`useChatDraft`'s `chat`): the same object while the chat's draft moves between
   * scopes, and another one once the person switches to another chat.
   */
  readonly chat: object;
  /** The text the composer shows now. */
  readonly text: string;
  readonly composer: ComposerTextTarget;
  readonly attachments: Pick<
    AttachmentManager,
    "restore" | "subscribe" | "toDraftRefs" | "dropPending"
  >;
  /** A prompt Up or Down recalled (U2.5) is not the draft. */
  readonly isRecalledPrompt: (text: string) => boolean;
}

/**
 * Whether two attachment lists name the same refs in the same order. The fields are compared one by one, so the order
 * a source wrote them in does not count.
 */
function sameRefs(left: readonly AttachmentRef[], right: readonly AttachmentRef[]): boolean {
  if (left.length !== right.length) return false;
  for (const [index, ref] of left.entries()) {
    const other = right[index];
    if (
      other === undefined ||
      ref.id !== other.id ||
      ref.name !== other.name ||
      ref.mediaType !== other.mediaType ||
      ref.sizeBytes !== other.sizeBytes ||
      ref.uri !== other.uri
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Binds the composer's text and attachments to the controller that holds the chat's draft. The composer shows the
 * draft once it has loaded, and what the person types or attaches is saved to it, including what they do before it
 * loads: that goes to the controller as it happens, so loading the draft never writes over it. A change the controller
 * makes to its text or attachments without the composer (a conflict's "Use the other tab's text", or another tab's
 * save to a draft this tab has no unsaved edit to) is shown in the composer, and is not saved back as typing.
 */
export function useComposerDraft({
  chat,
  controller,
  text,
  composer,
  attachments,
  isRecalledPrompt,
}: UseComposerDraftOptions): void {
  // The controller this composer last loaded its draft for. A thread switch can keep this composer
  // mounted (a branch re-keys the chat), so a new controller clears the text and loads its own draft.
  const hydratedFor = useRef<DraftController | null>(null);
  // The controller the composer has cleared its text for. The text on screen before that is the previous chat's.
  const clearedFor = useRef<DraftController | null>(null);
  // The text and attachments the composer and the controller last agreed on: the composer's own writes set them before
  // they reach the controller, and the values the composer takes from the controller set them too. A controller value
  // that differs was changed without the composer.
  const agreedText = useRef<string | null>(null);
  const agreedAttachments = useRef<readonly AttachmentRef[]>([]);
  // Attachment restores still running. While one runs the manager's list is partial, so the composer holds the list
  // being restored in its place.
  const restoring = useRef(0);
  // What the last restore could not bring back (its blob is gone or unreachable). The saved draft keeps these too.
  const lostAttachments = useRef<readonly AttachmentRef[]>([]);
  const snapshot = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getSnapshot(),
    () => controller.getSnapshot(),
  );

  // The attachments the saved draft keeps: the manager's, and any the last restore could not bring back.
  const attachmentsToSave = useCallback((): readonly AttachmentRef[] => {
    const held = attachments.toDraftRefs();
    const heldIds = new Set(held.map((ref) => ref.id));
    return [...held, ...lostAttachments.current.filter((ref) => !heldIds.has(ref.id))];
  }, [attachments]);

  // Saves the attachments the manager holds when they differ from the ones agreed on. The controller's own text
  // is kept: the composer's text is saved by `saveText` as it changes.
  const saveAttachments = useCallback(
    (owner: DraftController) => {
      // A restore that is still filling the manager's list is saved when it ends (see `restoreAttachments`).
      // Before the chat's draft loads, what the manager holds is the chat's own (the previous chat's was cleared when
      // this chat opened): it is saved to the controller now, and the controller merges it with the stored draft.
      if (clearedFor.current !== owner) return;
      if (restoring.current > 0) return;
      const draftAttachments = attachmentsToSave();
      if (sameRefs(draftAttachments, agreedAttachments.current)) return;
      agreedAttachments.current = draftAttachments;
      owner.setDraft(owner.getSnapshot().text, draftAttachments);
    },
    [attachmentsToSave],
  );

  const restoreAttachments = useCallback(
    (owner: DraftController, refs: readonly AttachmentRef[]) => {
      agreedAttachments.current = refs;
      restoring.current += 1;
      void attachments.restore(refs).then(
        () => {
          lostAttachments.current = [];
          restoring.current -= 1;
          if (restoring.current === 0) saveAttachments(owner);
        },
        () => {
          // A restore that stops at a blob it cannot read keeps the ones before it. The draft keeps the rest
          // too, until a later restore completes.
          const heldIds = new Set(attachments.toDraftRefs().map((ref) => ref.id));
          lostAttachments.current = refs.filter((ref) => !heldIds.has(ref.id));
          restoring.current -= 1;
        },
      );
    },
    [attachments, saveAttachments],
  );

  useEffect(() => {
    if (hydratedFor.current !== controller) {
      composer.setText("");
      // Nothing is agreed for a chat whose draft has not loaded: the text here is still the previous chat's.
      agreedText.current = null;
      // The attachments on screen are the previous chat's too: they leave with its text until this chat's draft loads.
      restoreAttachments(controller, []);
    }
    clearedFor.current = controller;
  }, [composer, controller, restoreAttachments]);
  useEffect(() => {
    if (snapshot.status !== "ready" || hydratedFor.current === controller) return;
    hydratedFor.current = controller;
    // Read now, not from the render: the text the person typed while the draft loaded is already in the controller.
    const current = controller.getSnapshot();
    agreedText.current = current.text;
    composer.setText(current.text);
    restoreAttachments(controller, current.attachments);
  }, [composer, controller, restoreAttachments, snapshot.status]);
  // The controller changed its text or attachments without the composer: the composer shows what it now holds.
  useEffect(
    () =>
      controller.subscribe(() => {
        if (hydratedFor.current !== controller) return;
        const current = controller.getSnapshot();
        if (
          current.text === agreedText.current &&
          sameRefs(current.attachments, agreedAttachments.current)
        ) {
          return;
        }
        agreedText.current = current.text;
        composer.setText(current.text);
        restoreAttachments(controller, current.attachments);
      }),
    [composer, controller, restoreAttachments],
  );

  // Saves the composer's text with the attachments the draft holds now: the manager's list, plus any lost ones,
  // or, while a restore fills the list, the list being restored.
  const saveText = useCallback(
    (shown: string) => {
      if (clearedFor.current !== controller) return;
      // Before the draft has loaded, an empty composer is the clear itself, not a deletion: saving it would blank the
      // chat's saved draft.
      if (hydratedFor.current !== controller && shown === "") return;
      // A prompt Up or Down recalled (U2.5) is not the draft: the saved draft stays what was typed.
      if (isRecalledPrompt(shown)) return;
      const draftAttachments =
        restoring.current > 0 ? agreedAttachments.current : attachmentsToSave();
      // The controller already holds this text and these attachments. Writing them again would mark the draft as typed
      // when it is not.
      if (shown === agreedText.current && sameRefs(draftAttachments, agreedAttachments.current)) {
        return;
      }
      agreedText.current = shown;
      agreedAttachments.current = draftAttachments;
      controller.setDraft(shown, draftAttachments);
    },
    [attachmentsToSave, controller, isRecalledPrompt],
  );
  // A layout effect: the typed text reaches the controller before the browser paints, so a move that hands off the
  // controller's text never misses what the person has just typed.
  useLayoutEffect(() => {
    saveText(text);
  }, [saveText, text]);
  // An attachment dropped, sent or removed changes the list without changing the text, so the draft is saved then too.
  useEffect(
    () => attachments.subscribe(() => saveAttachments(controller)),
    [attachments, controller, saveAttachments],
  );
  // A picture still being attached belongs to the chat it was dropped in. It is dropped when that chat is left: the
  // chat's identity ends (the person switched to another chat), or the composer goes with it. A move of the same chat's
  // draft keeps the identity, so the cleanup does not run.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cleanup runs when the chat changes.
  useEffect(() => () => attachments.dropPending(), [attachments, chat]);
}
