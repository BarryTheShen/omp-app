import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { OverlayContent } from "@/overlay/overlay-host";
import { CancelButton, DialogFrame } from "./common";
import type { OverlayOpener } from "./confirm-chat-delete";

/**
 * The confirmation before a typed `/usage reset` spends a saved reset. It is the U4 confirm dialog's frame and Cancel
 * button with the reset wording: Cancel spends nothing, and Spend reset spends one saved reset.
 */
function SpendResetConfirm({
  accountName,
  onDecide,
  onGone,
}: {
  readonly accountName: string;
  readonly onDecide: (confirmed: boolean) => void;
  /** The overlay closed without a choice (Escape or a click outside): nothing is spent. */
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
      title={`Spend a saved reset on ${accountName}?`}
      description="This spends one saved reset. A spent reset cannot be undone."
      actions={
        <>
          <CancelButton onCancel={() => onDecide(false)} />
          <Button type="button" variant="destructive" onClick={() => onDecide(true)}>
            Spend reset
          </Button>
        </>
      }
    >
      {null}
    </DialogFrame>
  );
}

/** Opens the confirmation before a saved reset is spent. It resolves true only when the person chooses Spend reset. */
export function openSpendResetConfirm(
  overlay: OverlayOpener,
  accountName: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const content: OverlayContent = ({ close }) => (
      <SpendResetConfirm
        accountName={accountName}
        onDecide={(confirmed) => {
          resolve(confirmed);
          close("programmatic");
        }}
        onGone={() => resolve(false)}
      />
    );
    overlay.open({ kind: "modal", label: "Reset usage", width: "content", content });
  });
}
