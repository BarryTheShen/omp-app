import type { ReactNode } from "react";
import { useEffect } from "react";
import type { RoleTrack as Track } from "./store";

/** How long the track shows after a switch: Tern's time for a toast that says something worked. */
const SHOWN_MS = 2200;

/**
 * After Ctrl+P: omp's roles in their order, the one the chat switched to filled, for a moment above the message box (omp
 * draws the same track above its editor). A role without a model is shown too, as omp shows it; Ctrl+P skips it.
 */
export function RoleTrack({
  track,
  onDone,
}: {
  readonly track: Track;
  readonly onDone: (id: number) => void;
}): ReactNode {
  useEffect(() => {
    const timer = window.setTimeout(() => onDone(track.id), SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [track.id, onDone]);
  return (
    <div
      role="status"
      aria-label="Roles"
      data-tour="role-track"
      className="animate-in fade-in-0 px-1 pb-2 duration-150"
    >
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
        {track.order.map((role) => (
          <li
            key={role}
            aria-current={role === track.current ? "true" : undefined}
            className={
              role === track.current
                ? "rounded-md bg-l2 px-2 py-0.5 text-t1"
                : "rounded-md px-2 py-0.5 text-t3"
            }
          >
            {role}
          </li>
        ))}
      </ol>
    </div>
  );
}
