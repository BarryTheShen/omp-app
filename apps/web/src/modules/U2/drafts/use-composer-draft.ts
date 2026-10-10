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
 * loads: that text goes to the controller as they type, so loading the draft never writes over it.
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
  const snapshot = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getSnapshot(),
    () => controller.getSnapshot(),
  );
  useEffect(() => {
    if (hydratedFor.current !== controller) composer.setText("");
    clearedFor.current = controller;
  }, [composer, controller]);
  useEffect(() => {
    if (snapshot.status !== "ready" || hydratedFor.current === controller) return;
    hydratedFor.current = controller;
    // Read now, not from the render: the text the person typed while the draft loaded is already in the controller.
    const current = controller.getSnapshot();
    composer.setText(current.text);
    void attachments.restore(current.attachments).catch(() => undefined);
  }, [attachments, composer, controller, snapshot.status]);
  // A layout effect: the typed text reaches the controller before the browser paints, so a move that hands off the
  // controller's text never misses what the person has just typed.
  useLayoutEffect(() => {
    if (clearedFor.current !== controller) return;
    // Before the draft has loaded, an empty composer is the clear itself, not a deletion: saving it would blank the
    // chat's saved draft.
    if (hydratedFor.current !== controller && text === "") return;
    // A prompt Up or Down recalled (U2.5) is not the draft: the saved draft stays what was typed.
    if (isRecalledPrompt(text)) return;
    controller.setDraft(text, attachments.toDraftRefs());
  }, [attachments, controller, isRecalledPrompt, text]);
}
