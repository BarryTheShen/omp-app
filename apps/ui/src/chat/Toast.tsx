import { cn } from "cn";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { ChatToast } from "./store";

/** Tern's toast times: a success shows for 2.2 s, anything else for 5.2 s, then fades out over 260 ms. */
const SHOWN_MS: Record<ChatToast["tone"], number> = {
  success: 2200,
  info: 5200,
  warning: 5200,
  error: 5200,
};
const FADE_MS = 260;

const DOT: Record<ChatToast["tone"], string> = {
  success: "bg-ok",
  info: "bg-accent-ink",
  warning: "bg-warn",
  error: "bg-bad",
};

/**
 * omp's status line as Tern draws a toast: above the message box, and above omp's requests and the plan when they sit
 * over it (the chat pane's anchor), centred, one at a time (a newer one takes its place and its time), then it fades. It
 * floats over the transcript, so nothing moves when it comes or goes.
 */
export function Toast({
  toast,
  onDone,
}: {
  readonly toast: ChatToast;
  readonly onDone: (id: number) => void;
}): ReactNode {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    setLeaving(false);
    const shown = SHOWN_MS[toast.tone];
    const fade = window.setTimeout(() => setLeaving(true), shown);
    const done = window.setTimeout(() => onDone(toast.id), shown + FADE_MS);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(done);
    };
  }, [toast.id, toast.tone, onDone]);
  return (
    <div
      role={toast.tone === "error" ? "alert" : "status"}
      data-tone={toast.tone}
      className={cn(
        "pointer-events-auto absolute bottom-full left-1/2 z-10 mb-1 flex max-w-[min(560px,92%)] -translate-x-1/2 items-center gap-2 rounded-[12px] border border-l3 bg-popover px-3.5 py-2 text-[0.8125rem] text-t1 shadow-lg",
        "animate-in fade-in-0 duration-150 transition-opacity",
        leaving && "opacity-0 duration-[260ms]",
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[toast.tone])} />
      {/* The store keeps a long note out of toasts; a narrow pane still never shows more than two lines. */}
      <span className="line-clamp-2 min-w-0 break-words">{toast.text}</span>
    </div>
  );
}
