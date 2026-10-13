import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { OverlayContent } from "@/overlay/overlay-host";
import { CancelButton, DialogFrame } from "./common";
import type { OverlayOpener } from "./confirm-chat-delete";

/** The words of the question asked before a typed command that deletes data runs in omp. */
export interface DestructiveConfirmText {
  /** The overlay's name for the dialog. */
  readonly label: string;
  /** Names the target as the person typed it. */
  readonly title: string;
  readonly description: string;
  /** The destructive button. Cancel, and closing the dialog, send nothing. */
  readonly confirmLabel: string;
}

/**
 * The question before a typed command that deletes data runs in omp. It is the U4 confirm dialog's frame and Cancel
 * button with the command's own wording: Cancel sends nothing, and the destructive button sends the command once.
 */
function DestructiveCommandConfirm({
  text,
  onDecide,
  onGone,
}: {
  readonly text: DestructiveConfirmText;
  readonly onDecide: (confirmed: boolean) => void;
  /** The overlay closed without a choice (Escape or a click outside): nothing is sent to omp. */
  readonly onGone: () => void;
}) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Checked after the effects settle, so React's development double mount does not count as a close.
      setTimeout(() => {
        if (!mounted.current) onGone();
      }, 0);
    };
  }, [onGone]);
  return (
    <DialogFrame
      title={text.title}
      description={text.description}
      actions={
        <>
          <CancelButton onCancel={() => onDecide(false)} />
          <Button type="button" variant="destructive" onClick={() => onDecide(true)}>
            {text.confirmLabel}
          </Button>
        </>
      }
    >
      {null}
    </DialogFrame>
  );
}

/**
 * Opens the question before a typed command that deletes data runs in omp. It resolves true only when the person chooses
 * the destructive button; Cancel, and closing the dialog, resolve false.
 */
export function openDestructiveCommandConfirm(
  overlay: OverlayOpener,
  text: DestructiveConfirmText,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const content: OverlayContent = ({ close }) => (
      <DestructiveCommandConfirm
        text={text}
        onDecide={(confirmed) => {
          resolve(confirmed);
          close("programmatic");
        }}
        onGone={() => resolve(false)}
      />
    );
    overlay.open({ kind: "modal", label: text.label, width: "content", content });
  });
}
