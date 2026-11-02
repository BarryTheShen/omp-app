import { Pause } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

/** How long the chat has been paused, as omp's pause screen counts it: `0:07`, `12:34`, `1:02:03`. */
export function pauseClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** omp's own words for a pause (pi-tui `pause-screen.ts`). */
const PAUSE_WORDS =
  "Main agent, subagents, and advisor hold at their next step. In-flight calls finish; nothing new starts until you resume. Steering and follow-ups already queued send after you resume.";

/**
 * The chat is paused (omp's `/pause`): how long, and how to go on. Resume, or Esc, Enter or Space in the empty box, as
 * in omp (`resumeKey`; a phone has no such keys, and its key row has Resume). A chat its usage pause holds says why and
 * when it goes on (`reason`, #2781 part 3).
 */
export function PausedRow({
  pausedAt,
  held = [],
  reason,
  onResume,
  resumeKey = true,
}: {
  readonly pausedAt: number;
  /** Messages sent while paused, which omp shows once the chat goes on. */
  readonly held?: readonly string[];
  /** Why the chat is paused, when the app paused it: "At 95% of anthropic's 5-hour limit · resumes at 14:01". */
  readonly reason?: string;
  readonly onResume: () => void;
  readonly resumeKey?: boolean;
}): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div data-tour="paused" className="flex min-w-0 items-center gap-2 px-1 pb-2 text-xs text-t3">
      <span className="flex min-w-0 flex-1 items-center gap-2" role="status" title={PAUSE_WORDS}>
        <Pause className="size-3.5 shrink-0 text-warn-ink" aria-hidden="true" />
        <span className="shrink-0 font-medium text-t1">Paused</span>
        <span className="shrink-0 tabular-nums">{pauseClock(now - pausedAt)}</span>
        {reason !== undefined && <span className="min-w-0 truncate">{reason}</span>}
        {held.length > 0 ? (
          <span className="min-w-0 truncate" title={held.join("\n")}>
            {held.length === 1 ? "1 message waits" : `${held.length} messages wait`}
          </span>
        ) : (
          reason === undefined && (
            <span className="min-w-0 truncate">Every agent holds at its next step</span>
          )
        )}
      </span>
      <button
        type="button"
        className="shrink-0 rounded-md px-2 py-0.5 font-medium text-t1 hover:bg-l1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={onResume}
      >
        Resume
      </button>
      {resumeKey && (
        <span className="shrink-0">
          <kbd className="rounded-sm border border-l2 px-1 font-mono text-[11px]">esc</kbd> to
          resume
        </span>
      )}
    </div>
  );
}
