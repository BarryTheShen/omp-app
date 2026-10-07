export function TranscriptLiveStatus() {
  return (
    <p
      aria-atomic="true"
      aria-live="polite"
      className="sr-only"
      data-slot="u1-transcript-live-status"
      role="status"
    >
      The latest message is below. Use Jump to latest to follow along.
    </p>
  );
}
