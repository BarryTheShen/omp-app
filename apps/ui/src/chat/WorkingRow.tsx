import { type ReactNode, useEffect, useState } from "react";
import type { ChatActivity } from "./store";

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * What omp is doing, how long it has been at it, and how to stop it: Esc, where there is a key for it (`stopKey`; a
 * phone has none, and its Stop button is beside the box). What it is given (the phone's pills) shares the row.
 */
export function WorkingRow({
  activity,
  stopKey = true,
  children,
}: {
  readonly activity: ChatActivity;
  readonly stopKey?: boolean;
  readonly children?: ReactNode;
}): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 pb-2 text-xs text-t3">
      <span className="flex min-w-0 flex-1 items-center gap-2" role="status">
        <span className="size-1.5 shrink-0 rounded-full bg-live" aria-hidden="true" />
        <span className="min-w-0 truncate text-t2">{activity.label}</span>
        <span className="tabular-nums">{elapsed(now - activity.since)}</span>
        {stopKey && (
          <span className="ml-auto shrink-0">
            <kbd className="rounded-sm border border-l2 px-1 font-mono text-[11px]">esc</kbd> to
            stop
          </span>
        )}
      </span>
      {children}
    </div>
  );
}
