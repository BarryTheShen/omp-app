import type { AttachmentRef } from "@omp-app/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { AttachmentManager } from "../attachments";
import type { DraftController } from "./drafts";

/** The composer's text, as the draft binding sets it. */
interface ComposerTextTarget {
  setText(text: string): void;
}

/** The current recalled prompt is display-only; pagehide must save the controller's actual draft instead. */
export function composerDraftForLifecycle(
  controller: DraftController,
  visibleText: string,
  visibleAttachments: readonly AttachmentRef[],
  isRecalledPrompt: (text: string) => boolean,
): { readonly text: string; readonly attachments: readonly AttachmentRef[] } {
  if (!isRecalledPrompt(visibleText)) return { text: visibleText, attachments: visibleAttachments };
  const draft = controller.getSnapshot();
  return { text: draft.text, attachments: draft.attachments };
}

interface UseComposerDraftOptions {
  /** The controller that holds the chat's draft right now. */
  readonly controller: DraftController;
  /**
   * The chat the draft belongs to (`useChatDraft`'s `chat`): the same object while the chat's draft moves between
   * scopes, and another one once the person switches to another chat.
   */
  readonly chat: object;
  /** True while history is replacing the chat shown in the composer. */
  readonly switching?: boolean;
  /** The text the composer shows now. */
  readonly text: string;
  readonly composer: ComposerTextTarget;
  readonly attachments: Pick<
    AttachmentManager,
    "restore" | "subscribe" | "toDraftRefs" | "dropPending" | "holdForSend" | "takeHeldForSend"
  >;
  /** A prompt Up or Down recalled (U2.5) is not the draft. */
  readonly isRecalledPrompt: (text: string) => boolean;
  /**
   * Holds the chat's draft while a send settles (`useChatDraft`'s `hold`): no move runs until the text typed during
   * the send is in the controller. Without it the composer only keeps its own text apart.
   */
  readonly hold?: () => () => void;
}

/** Keeps the box apart from the draft while a send is in flight (see `useComposerDraft`). */
export interface ComposerSendHold {
  /** At Enter: the box empties and takes new text, which the draft gets once the send has settled. */
  readonly beginSend: () => void;
  /** Once the send has settled: what was typed meanwhile becomes the draft, or the box shows what the draft holds. */
  readonly endSend: () => void;
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
  switching = false,
  text,
  composer,
  attachments,
  isRecalledPrompt,
  hold,
}: UseComposerDraftOptions): ComposerSendHold {
  // The controller this composer last loaded its draft for. A thread switch can keep this composer
  // mounted (a branch re-keys the chat), so a new controller clears the text and loads its own draft.
  const hydratedFor = useRef<DraftController | null>(null);
  // The controller the composer has cleared its text for. The text on screen before that is the previous chat's.
  const clearedFor = useRef<DraftController | null>(null);
  // The chat whose text the composer last cleared. A new controller of the same chat keeps the text and the caret.
  const clearedChat = useRef<object | null>(null);
  const switchingRef = useRef(false);
  // The text and attachments the composer and the controller last agreed on: the composer's own writes set them before
  // they reach the controller, and the values the composer takes from the controller set them too. A controller value
  // that differs was changed without the composer.
  const agreedText = useRef<string | null>(null);
  // Nothing is agreed for a chat whose draft has not loaded: its first typed value belongs to that controller.
  const agreedAttachments = useRef<readonly AttachmentRef[]>([]);
  // Attachment restores still running. While one runs the manager's list is partial, so the composer holds the list
  // being restored in its place.
  const restoring = useRef(0);
  // What the last restore could not bring back (its blob is gone or unreachable). The saved draft keeps these too.
  const lostAttachments = useRef<readonly AttachmentRef[]>([]);
  // The restore still loading, if any: a newer restore or a chat change replaces it (see `restoreAttachments`).
  const restoreAbort = useRef<AbortController | null>(null);
  // The send in flight, from Enter until it has settled (see `beginSend`): the box and the controller stay apart
  // meanwhile. The controller keeps the sent text until admission, and text typed in the box must not join it (issue 2659).
  const sending = useRef<{ readonly chat: object; readonly release: () => void } | null>(null);
  const latestText = useRef(text);
  latestText.current = text;
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
      // The attachments on screen are the previous chat's too until this controller's draft has loaded.
      // Before the chat's draft loads, what the manager holds is the chat's own (the previous chat's was cleared when
      // this chat opened): it is saved to the controller now, and the controller merges it with the stored draft.
      if (clearedFor.current !== owner) return;
      if (sending.current !== null) return;
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
      // A newer restore replaces the one still loading: its pictures must not reach the list the newer one holds.
      restoreAbort.current?.abort();
      const abort = new AbortController();
      restoreAbort.current = abort;
      agreedAttachments.current = refs;
      restoring.current += 1;
      void attachments.restore(refs, { signal: abort.signal }).then(
        () => {
          restoring.current -= 1;
          // A replaced restore changes nothing and saves nothing: the newer restore does both.
          if (abort.signal.aborted) return;
          lostAttachments.current = [];
          if (restoring.current === 0) saveAttachments(owner);
        },
        () => {
          restoring.current -= 1;
          if (abort.signal.aborted) return;
          // A restore that stops at a blob it cannot read keeps the ones before it. The draft keeps the rest
          // too, until a later restore completes.
          const heldIds = new Set(attachments.toDraftRefs().map((ref) => ref.id));
          lostAttachments.current = refs.filter((ref) => !heldIds.has(ref.id));
        },
      );
    },
    [attachments, saveAttachments],
  );

  useEffect(() => {
    if (hydratedFor.current !== controller) {
      const sameChat = clearedChat.current === chat;
      const movedFromFolder =
        clearedFor.current?.getSnapshot().scope.kind === "folder" &&
        controller.getSnapshot().scope.kind === "thread";
      // A recalled prompt is display-only: retain it while the same chat's folder draft moves to its thread scope.
      const keepRecalledPrompt = sameChat && movedFromFolder && isRecalledPrompt(text);
      if (!sameChat && !keepRecalledPrompt) {
        composer.setText("");
        agreedText.current = null;
        restoreAttachments(controller, []);
      }
      clearedChat.current = chat;
    }
    clearedFor.current = controller;
  }, [chat, composer, controller, isRecalledPrompt, restoreAttachments, text]);
  useEffect(() => {
    if (!switching || switchingRef.current) {
      switchingRef.current = switching;
      return;
    }
    switchingRef.current = true;
    const current = controller.getSnapshot();
    if (isRecalledPrompt(text)) return;
    // A switch signal can arrive while the person is typing; the layout effect has already put newer text in the
    // controller, so do not clear it over that newer value.
    if (hydratedFor.current === controller && text !== current.text) return;
    composer.setText("");
    agreedText.current = current.text;
    composer.setText(current.text);
    restoreAttachments(controller, current.attachments);
  }, [composer, controller, isRecalledPrompt, restoreAttachments, switching, text]);
  useEffect(() => {
    if (snapshot.status !== "ready" || hydratedFor.current === controller || isRecalledPrompt(text))
      return;
    hydratedFor.current = controller;
    // Read now, not from the render: the text the person typed while the draft loaded is already in the controller.
    const current = controller.getSnapshot();
    agreedText.current = current.text;
    composer.setText(current.text);
    restoreAttachments(controller, current.attachments);
  }, [composer, controller, isRecalledPrompt, restoreAttachments, snapshot.status, text]);
  // The controller changed its text or attachments without the composer: the composer shows what it now holds.
  useEffect(
    () =>
      controller.subscribe(() => {
        if (hydratedFor.current !== controller || isRecalledPrompt(text)) return;
        if (sending.current !== null) return;
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
    [composer, controller, isRecalledPrompt, restoreAttachments, text],
  );

  // Saves the composer's text with the attachments the draft holds now: the manager's list, plus any lost ones,
  // or, while a restore fills the list, the list being restored.
  const saveText = useCallback(
    (shown: string) => {
      if (clearedFor.current !== controller) return;
      if (sending.current !== null) return;
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
  useEffect(
    () => () => {
      // A restore still loading for that chat is replaced with the chat, so its pictures do not reach the next chat.
      restoreAbort.current?.abort();
      attachments.dropPending();
    },
    [attachments, chat],
  );

  const beginSend = useCallback(() => {
    if (sending.current !== null) return;
    sending.current = { chat, release: hold?.() ?? (() => undefined) };
    composer.setText("");
    // The send carries what the composer holds now, though the list empties for the next message (issue 2681).
    attachments.holdForSend();
    restoreAttachments(controller, []);
  }, [attachments, chat, composer, controller, hold, restoreAttachments]);

  const endSend = useCallback(() => {
    const held = sending.current;
    if (held === null) return;
    sending.current = null;
    // A copy no send took is dropped, so no later send carries it.
    attachments.takeHeldForSend();
    // A chat the person switched to during the send has its own text: the composer's sync for it is already running.
    if (held.chat === chat) {
      const typed = latestText.current;
      const refs = attachmentsToSave();
      if (typed !== "" || refs.length > 0) {
        // What was typed during the send is the draft now. The sent text is gone from the controller (it was admitted)
        // or kept in its failed sends (it failed).
        agreedText.current = typed;
        agreedAttachments.current = refs;
        controller.setDraft(typed, refs);
      } else {
        // Nothing was typed: the box shows what the draft holds, empty after an admitted send, the text after a failed one.
        const current = controller.getSnapshot();
        agreedText.current = current.text;
        composer.setText(current.text);
        restoreAttachments(controller, current.attachments);
      }
    }
    held.release();
  }, [attachments, attachmentsToSave, chat, composer, controller, restoreAttachments]);

  return { beginSend, endSend };
}
