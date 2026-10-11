import "./thread-scroll.css";
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
  return (
    <div className="min-h-8" data-slot="u1-scroll-follow-controls">
      <TranscriptLiveStatus />
      <Toolbar ariaLabel="Transcript actions" alignment="end">
        <Button
          aria-label="Jump to latest message"
          className="disabled:hidden"
          data-slot="u1-scroll-to-bottom"
          disabled={isAtBottom}
          onClick={() => onFollowLatest()}
          size="sm"
          type="button"
          variant="outline"
        >
          Jump to latest
        </Button>
      </Toolbar>
    </div>
  );
}
