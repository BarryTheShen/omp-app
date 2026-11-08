import { type ReactNode, useEffect, useState } from "react";
import type { ChatActivity } from "./store";

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * What omp is doing, how long it has been at it, and how to stop it: Esc, where there is a key for it (`stopKey`; a
 * phone has none, and its Stop button is beside the box). Pause (`onPause`) holds every agent at its next step, as omp's
 * `/pause`; a phone has it in its ＋ sheet.
 *
 * The line is a grid so that the dot and the time keep their room: the step's name gives way first (its column can
 * shrink to nothing).
 */
export function WorkingRow({
  activity,
  stopKey = true,
  onPause,
}: {
  readonly activity: ChatActivity;
  readonly stopKey?: boolean;
  readonly onPause?: () => void;
}): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 pb-2 text-xs text-t3">
      <span
        className="grid flex-1 grid-cols-[auto_minmax(0,max-content)_auto_1fr] items-center gap-2"
        role="status"
      >
        <span className="size-1.5 rounded-full bg-live" aria-hidden="true" />
        <span className="truncate text-t2">{activity.label}</span>
        <span className="whitespace-nowrap tabular-nums">{elapsed(now - activity.since)}</span>
        {stopKey && (
          <span className="justify-self-end whitespace-nowrap">
            <kbd className="rounded-sm border border-l2 px-1 font-mono text-[11px]">esc</kbd> to
            stop
          </span>
        )}
      </span>
      {onPause !== undefined && (
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-0.5 text-t2 hover:bg-l1 hover:text-t1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          title="Every agent holds at its next step; a reply or tool under way finishes"
          onClick={onPause}
        >
          Pause
        </button>
      )}
    </div>
  );
}

/**
 * The working line's room while nothing runs, on a computer: the line (or the paused one) comes and goes in it, so the
 * chat above does not move when a turn starts or ends. As tall as the line with its Pause button.
 */
export function WorkingRowSpace(): ReactNode {
  return (
    <div aria-hidden="true" className="invisible flex min-w-0 items-center px-1 pb-2 text-xs">
      <span className="py-0.5">Pause</span>
    </div>
  );
}
