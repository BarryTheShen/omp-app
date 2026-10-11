import type { DraftInput } from "@omp-app/contracts";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { DraftSnapshot } from "./drafts";

export interface DraftNoticeProps {
  readonly snapshot: DraftSnapshot;
  /** Runs the step that failed again. */
  readonly onRetry: () => void;
  /** Keeps this tab's text, or takes the other tab's. */
  readonly onResolve: (choice: "local" | "remote") => Promise<void>;
  /** Puts the earlier draft back in front of the text typed since ("restore"), or forgets it ("dismiss"). */
  readonly onResolveReplaced: (choice: "restore" | "dismiss") => void;
}

/** The most of the other tab's text a notice shows: one line, cut with an ellipsis. */
const PREVIEW_CHARACTERS = 80;

/** The text on one line, cut to about PREVIEW_CHARACTERS characters. */
function previewOf(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= PREVIEW_CHARACTERS) return line;
  return `${line.slice(0, PREVIEW_CHARACTERS - 1).trimEnd()}…`;
}

/** The earlier draft in a few words: the start of its text, and how many attachments it had. */
function summaryOf(earlier: DraftInput): string {
  const count = earlier.attachments.length;
  const attached = count === 0 ? "" : `${count} attachment${count === 1 ? "" : "s"}`;
  const text = earlier.text === "" ? "" : previewOf(earlier.text);
  return [text, attached].filter((part) => part !== "").join(", ");
}

/**
 * The draft's conflict or failure, in plain words, with the way out. A conflict shows the start of the other tab's
 * text, so the choice is not blind, and offers this tab's text or the other tab's. A failure gives its reason and a
 * Retry. The composer is disabled only while a failure shows, so it is never disabled without its reason next to it.
 * A draft that typing replaced is offered last, with a way to restore it or dismiss it.
 */
export function DraftNotice({
  snapshot,
  onRetry,
  onResolve,
  onResolveReplaced,
}: DraftNoticeProps): ReactNode {
  if (snapshot.status === "conflict" && snapshot.conflict !== null) {
    const remote = snapshot.conflict.remote;
    const preview = remote === null ? "" : previewOf(remote.text);
    const cleared = remote === null || (preview === "" && remote.attachments.length === 0);
    return (
      <div
        role="alert"
        className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 px-(--space-md) py-(--space-2xs) text-sm text-warning-foreground"
      >
        <p>{cleared ? "The other tab cleared this draft." : "The other tab changed this draft."}</p>
        {remote === null || preview === "" ? null : (
          <p className="text-muted-foreground min-w-0 truncate text-xs" title={remote.text}>
            {preview}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => void onResolve("local").catch(() => undefined)}
          >
            Keep this tab's text
          </Button>
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => void onResolve("remote").catch(() => undefined)}
          >
            Use the other tab's text
          </Button>
        </div>
      </div>
    );
  }
  if (snapshot.status === "error") {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-2 rounded-lg border border-danger/30 bg-danger-surface px-(--space-md) py-(--space-2xs) text-sm text-danger-surface-foreground"
      >
        <p className="min-w-0 flex-1">
          {snapshot.error?.message ?? "The draft could not be saved."}
        </p>
        <Button size="sm" type="button" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (snapshot.replaced !== null) {
    const earlier = snapshot.replaced;
    const summary = summaryOf(earlier);
    return (
      <div
        role="status"
        className="flex flex-col gap-2 rounded-lg border border-border bg-muted px-(--space-md) py-(--space-2xs) text-sm text-foreground"
      >
        <p>Your earlier draft was replaced by what you typed before it loaded.</p>
        {summary === "" ? null : (
          <p className="text-muted-foreground min-w-0 truncate text-xs" title={earlier.text}>
            {summary}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => onResolveReplaced("restore")}
          >
            Restore your earlier draft
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => onResolveReplaced("dismiss")}
          >
            Dismiss
          </Button>
        </div>
      </div>
    );
  }
  return null;
}
