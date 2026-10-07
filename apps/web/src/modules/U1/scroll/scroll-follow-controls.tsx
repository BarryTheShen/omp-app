import "./thread-scroll.css";
import { ThreadPrimitive } from "@assistant-ui/react";
import { useEffect, useRef } from "react";
import { Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { TranscriptLiveStatus } from "../a11y";

export interface ScrollFollowControlsProps {
  /** Scrolls to the newest message and focuses the transcript (the controller's `followLatest`). */
  readonly onFollowLatest: () => void;
  readonly onAtBottomChange: (isAtBottom: boolean) => void;
}

/**
 * The "Jump to latest" button, shown while the reader is away from the newest message. assistant-ui
 * decides when that is (its button is disabled at the bottom); the scroll itself is ours, because
 * the library's animation aims at the bottom as it was when it started and lands short of rows
 * drawn lazily on the way. The layout supplies this view to the thread footer.
 */
export function ScrollFollowControls({
  onFollowLatest,
  onAtBottomChange,
}: ScrollFollowControlsProps) {
  const controlsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const button = controlsRef.current?.querySelector<HTMLButtonElement>(
      '[data-slot="u1-scroll-to-bottom"]',
    );
    if (button === null || button === undefined) return;

    onAtBottomChange(button.disabled);
    const observer = new MutationObserver(() => onAtBottomChange(button.disabled));
    observer.observe(button, { attributes: true, attributeFilter: ["disabled"] });
    return () => observer.disconnect();
  }, [onAtBottomChange]);

  return (
    <div ref={controlsRef} className="min-h-8" data-slot="u1-scroll-follow-controls">
      <TranscriptLiveStatus />
      <Toolbar ariaLabel="Transcript actions" alignment="end">
        <ThreadPrimitive.ScrollToBottom
          onClick={(event) => {
            // Skip the library's own scroll: ours lands on the real bottom.
            event.preventDefault();
            onFollowLatest();
          }}
          render={
            <Button
              aria-label="Jump to latest message"
              className="disabled:hidden"
              data-slot="u1-scroll-to-bottom"
              size="sm"
              type="button"
              variant="outline"
            />
          }
        >
          Jump to latest
        </ThreadPrimitive.ScrollToBottom>
      </Toolbar>
    </div>
  );
}
