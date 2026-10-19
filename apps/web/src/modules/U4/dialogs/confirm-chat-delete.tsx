import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { OverlayContent, OverlayOpenOptions } from "@/overlay/overlay-host";
import { CancelButton, DialogFrame } from "./common";

/** The part of the overlay host this confirmation needs: opening a modal. */
export interface OverlayOpener {
  open(options: OverlayOpenOptions): unknown;
}

/**
 * The confirmation before a chat is deleted. It is the U4 confirm dialog's frame and Cancel button with the
 * delete wording: Cancel keeps the chat, Delete removes it. The approval dialog keeps its Deny and Confirm.
 */
function ChatDeleteConfirm({
  chatTitle,
  notice,
  onDecide,
  onGone,
}: {
  readonly chatTitle: string;
  readonly notice?: string;
  readonly onDecide: (confirmed: boolean) => void;
  /** The overlay closed without a choice (Escape or a click outside): the chat is kept. */
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
      title={`Delete "${chatTitle}"?`}
      description="Deleting this chat cannot be undone."
      actions={
        <>
          <CancelButton onCancel={() => onDecide(false)} />
          <Button type="button" variant="destructive" onClick={() => onDecide(true)}>
            Delete
          </Button>
        </>
      }
    >
      {notice ? <p className="mb-3 text-sm">{notice}</p> : null}
    </DialogFrame>
  );
}

/** Opens the confirmation before a chat is deleted. It resolves true only when the person chooses Delete. */
export function openChatDeleteConfirm(
  overlay: OverlayOpener,
  chatTitle: string,
  notice?: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const content: OverlayContent = ({ close }) => (
      <ChatDeleteConfirm
        chatTitle={chatTitle}
        notice={notice}
        onDecide={(confirmed) => {
          resolve(confirmed);
          close("programmatic");
        }}
        onGone={() => resolve(false)}
      />
    );
    overlay.open({ kind: "modal", label: "Delete chat", width: "content", content });
  });
}
