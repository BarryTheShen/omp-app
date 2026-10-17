import type { CollaborationGuestPrompt } from "../contract";

export interface GuestPromptRowProps {
  readonly prompt: CollaborationGuestPrompt;
  /** The participant's display name from the collaboration roster. */
  readonly authorName: string;
}

/** An upstream-admitted guest prompt: visible attribution, never an editable composer message. */
export function GuestPromptRow({ prompt, authorName }: GuestPromptRowProps) {
  const date = new Date(prompt.timestamp);
  const hasValidDate = Number.isFinite(date.getTime());
  const timestamp = hasValidDate
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)
    : "Time unavailable";

  return (
    <article
      aria-label={`Guest prompt from ${authorName}`}
      className="border-border bg-muted/40 text-muted-foreground mx-auto w-full max-w-(--layout-thread-width) rounded-md border px-3 py-2 text-sm"
      data-slot="i4-guest-prompt-row"
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">{authorName}</span>
        <time dateTime={hasValidDate ? date.toISOString() : undefined}>{timestamp}</time>
      </div>
      <p className="mt-1 whitespace-pre-wrap wrap-anywhere">{prompt.text}</p>
      <span className="mt-2 inline-flex rounded border border-border/70 px-1.5 py-0.5 text-[0.7rem]">
        Read-only
      </span>
    </article>
  );
}
