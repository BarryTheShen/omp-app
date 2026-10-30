import type { ThreadId } from "@omp-app/contracts";
import { useEffect, useRef } from "react";
import { notifyDesktop } from "./bridge";

/**
 * In the desktop window: a chat that starts waiting for you (an approval, a question) while the window is in the
 * background raises a desktop notification with its pane's title. `waiting` maps each open chat that waits to its
 * pane's title. In a browser nothing is shown.
 */
export function useWaitingNotifications(waiting: ReadonlyMap<ThreadId, string>): void {
  const seen = useRef(waiting);
  useEffect(() => {
    const before = seen.current;
    seen.current = waiting;
    if (document.hasFocus()) return;
    for (const [id, title] of waiting) {
      if (!before.has(id)) notifyDesktop(title === "" ? "A chat" : title, "Waiting for you");
    }
  }, [waiting]);
}
