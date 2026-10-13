import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { OverlayContent } from "@/overlay/overlay-host";
import { CancelButton, DialogFrame } from "./common";
import type { OverlayOpener } from "./confirm-chat-delete";

/**
 * The confirmation before a typed `/wt` moves this chat into a worktree. omp's setting that also cleans the folder's own
 * checkout is one the app cannot read, so the question says it may happen. Cancel moves nothing; Move chat sends the command.
 */
function WorktreeConfirm({
  branch,
  onDecide,
  onGone,
}: {
  readonly branch: string;
  readonly onDecide: (confirmed: boolean) => void;
  /** The overlay closed without a choice (Escape or a click outside): nothing is moved. */
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
      title={
        branch === ""
          ? "Move this chat into a new worktree?"
          : `Move this chat into a worktree on branch ${branch}?`
      }
      description="The chat and its uncommitted changes move into the worktree. If omp's setting Clean Source Checkout on /wt is on, this folder's checkout is also reset, and files that git does not track are removed from it."
      actions={
        <>
          <CancelButton onCancel={() => onDecide(false)} />
          <Button type="button" onClick={() => onDecide(true)}>
            Move chat
          </Button>
        </>
      }
    >
      {null}
    </DialogFrame>
  );
}

/** Opens the confirmation before a typed `/wt`. It resolves true only when the person chooses Move chat. */
export function openWorktreeConfirm(overlay: OverlayOpener, branch: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const content: OverlayContent = ({ close }) => (
    <WorktreeConfirm
      branch={branch}
      onDecide={(confirmed) => {
        resolve(confirmed);
        close("programmatic");
      }}
      onGone={() => resolve(false)}
    />
  );
  overlay.open({ kind: "modal", label: "Move to worktree", width: "content", content });
  return promise;
}
