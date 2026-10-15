import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { CancelButton, DialogFrame } from "@/modules/U4/dialogs/common";
import type { OverlayOpener } from "@/modules/U4/dialogs/confirm-chat-delete";
import type { OverlayContent } from "@/overlay/overlay-host";
import type { SecurityConfirmation } from "./actions";

function SecurityConfirm({
  confirmation,
  onDecide,
  onGone,
}: {
  readonly confirmation: SecurityConfirmation;
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
      title={confirmation.title}
      description={confirmation.message}
      actions={
        <>
          <CancelButton onCancel={() => onDecide(false)} />
          <Button
            type="button"
            variant={confirmation.destructive ? "destructive" : "default"}
            onClick={() => onDecide(true)}
          >
            {confirmation.confirmLabel}
          </Button>
        </>
      }
    >
      {null}
    </DialogFrame>
  );
}

/**
 * Asks before a destructive `/security` action. It resolves true only when the person chooses the
 * confirm button; Cancel, Escape and a click outside all resolve false, and omp receives nothing.
 */
export function openSecurityConfirm(
  overlay: OverlayOpener,
  confirmation: SecurityConfirmation,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const content: OverlayContent = ({ close }) => (
      <SecurityConfirm
        confirmation={confirmation}
        onDecide={(confirmed) => {
          resolve(confirmed);
          close("programmatic");
        }}
        onGone={() => resolve(false)}
      />
    );
    overlay.open({ kind: "modal", label: confirmation.title, width: "content", content });
  });
}
