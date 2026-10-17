import type { ReactNode } from "react";

export interface ReadOnlyTranscriptRowProps {
  readonly children: ReactNode;
  readonly label?: string;
}

/** Shared presentation wrapper for transcript content received from a read-only collaboration session. */
export function ReadOnlyTranscriptRow({
  children,
  label = "Read-only transcript",
}: ReadOnlyTranscriptRowProps) {
  return (
    <article
      aria-label={label}
      inert
      className="border-border/70 bg-muted/20 text-muted-foreground mx-auto w-full max-w-(--layout-thread-width) border-l px-3 py-2 text-sm"
      data-slot="i4-read-only-row"
    >
      {children}
    </article>
  );
}
