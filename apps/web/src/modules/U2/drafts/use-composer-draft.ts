import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { AttachmentManager } from "../attachments";
import type { DraftController } from "./drafts";

/** The composer's text, as the draft binding sets it. */
interface ComposerTextTarget {
  setText(text: string): void;
}

interface UseComposerDraftOptions {
  /** The controller that holds the chat's draft right now. */
  readonly controller: DraftController;
  /** The text the composer shows now. */
  readonly text: string;
  readonly composer: ComposerTextTarget;
  readonly attachments: Pick<AttachmentManager, "restore" | "toDraftRefs">;
  /** A prompt Up or Down recalled (U2.5) is not the draft. */
  readonly isRecalledPrompt: (text: string) => boolean;
}

/**
 * Binds the composer's text and attachments to the controller that holds the chat's draft. The composer shows
 * the draft once it has loaded, and what the person types is saved to it, including what they type before it
 * loads: that text goes to the controller as they type, so loading the draft never writes over it. A change the
 * controller makes to its text without the composer (a conflict's "Use the other tab's text", or another tab's
 * save to a draft this tab has no unsaved edit to) is shown in the composer, and is not saved back as typing.
 */
export function useComposerDraft({
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
  // The text the composer and the controller last agreed on: the composer's own writes set it before they reach the
  // controller, and the text the composer takes from the controller sets it too. A controller text that differs from
  // it was changed without the composer.
  const agreedText = useRef<string | null>(null);
  const snapshot = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getSnapshot(),
    () => controller.getSnapshot(),
  );
  useEffect(() => {
    if (hydratedFor.current !== controller) {
      composer.setText("");
      // Nothing is agreed for a chat whose draft has not loaded: the text here is still the previous chat's.
      agreedText.current = null;
    }
    clearedFor.current = controller;
  }, [composer, controller]);
  useEffect(() => {
    if (snapshot.status !== "ready" || hydratedFor.current === controller) return;
    hydratedFor.current = controller;
    // Read now, not from the render: the text the person typed while the draft loaded is already in the controller.
    const current = controller.getSnapshot();
    agreedText.current = current.text;
    composer.setText(current.text);
    void attachments.restore(current.attachments).catch(() => undefined);
  }, [attachments, composer, controller, snapshot.status]);
  // The controller changed its text without the composer: the composer shows the text the controller now holds.
  useEffect(
    () =>
      controller.subscribe(() => {
        if (hydratedFor.current !== controller) return;
        const current = controller.getSnapshot();
        if (current.text === agreedText.current) return;
        agreedText.current = current.text;
        composer.setText(current.text);
        void attachments.restore(current.attachments).catch(() => undefined);
      }),
    [attachments, composer, controller],
  );
  // A layout effect: the typed text reaches the controller before the browser paints, so a move that hands off the
  // controller's text never misses what the person has just typed.
  useLayoutEffect(() => {
    if (clearedFor.current !== controller) return;
    // Before the draft has loaded, an empty composer is the clear itself, not a deletion: saving it would blank the
    // chat's saved draft.
    if (hydratedFor.current !== controller && text === "") return;
    // A prompt Up or Down recalled (U2.5) is not the draft: the saved draft stays what was typed.
    if (isRecalledPrompt(text)) return;
    // The controller already holds this text. Writing it again would mark the draft as typed when it is not.
    if (text === agreedText.current) return;
    agreedText.current = text;
    controller.setDraft(text, attachments.toDraftRefs());
  }, [attachments, controller, isRecalledPrompt, text]);
}
