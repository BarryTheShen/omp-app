import "./thread-scroll.css";
import { useAuiState } from "@assistant-ui/react";
import { ArrowDownIcon } from "lucide-react";
import { Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { TranscriptLiveStatus } from "../a11y";

export interface ScrollFollowControlsProps {
  /** Whether the reader is at the newest message: the Jump control shows only while they are away. */
  readonly isAtBottom: boolean;
  /** Scrolls to the newest message and focuses the transcript (the controller's `followLatest`). */
  readonly onFollowLatest: () => void;
}

/**
 * The "Jump to latest" button, shown while the reader is away from the newest message. The controller decides that from
 * the viewport (`isAtBottom`), not from assistant-ui's own state, which can miss a step up while a reply grows (issue
 * 1183). The scroll itself is ours, because the library's animation aims at the bottom as it was when it started and lands
 * short of rows drawn lazily on the way. The layout supplies this view to the thread footer.
 */
export function ScrollFollowControls({ isAtBottom, onFollowLatest }: ScrollFollowControlsProps) {
  const hasMessages = useAuiState((state) => state.thread.messages.length > 0);
  const showButton = hasMessages && !isAtBottom;
  return (
    <div className={showButton ? "min-h-8" : "min-h-0"} data-slot="u1-scroll-follow-controls">
      <TranscriptLiveStatus />
      <Toolbar ariaLabel="Transcript actions">
        {showButton ? (
          <Button
            aria-label="Jump to latest message"
            className="border-foreground/10 bg-background hover:border-foreground/25 rounded-control absolute -top-11 start-1/2 z-10 grid size-8 -translate-x-1/2 place-items-center border transition-colors"
            data-slot="u1-scroll-to-bottom"
            onClick={() => onFollowLatest()}
            type="button"
            variant="ghost"
          >
            <ArrowDownIcon aria-hidden="true" className="size-4" />
            <span className="sr-only">Jump to latest</span>
          </Button>
        ) : null}
      </Toolbar>
    </div>
  );
}
