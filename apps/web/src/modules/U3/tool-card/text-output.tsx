import { useMemo, useState } from "react";
import { Button } from "../../../components/ui/button";

const PREVIEW_LINES = 16;

export interface TextOutputProps {
  /** The text a tool returned, exactly as omp sent it. */
  readonly text: string;
  readonly testId?: string;
}

/**
 * The text a tool returned, bounded: the first lines at once and a button for the rest, so a page
 * of 50 KB never takes the transcript over. The text is one preformatted node, never one element
 * per line.
 */
export function TextOutput({ text, testId }: TextOutputProps) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => text.split("\n"), [text]);
  const foldable = lines.length > PREVIEW_LINES;
  const shown = useMemo(
    () => (foldable && !expanded ? lines.slice(0, PREVIEW_LINES).join("\n") : text),
    [expanded, foldable, lines, text],
  );
  return (
    <div className="flex min-w-0 flex-col gap-2" data-slot="u3-text-output">
      <pre
        className="border-border bg-muted/40 text-foreground max-h-96 min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 font-mono text-xs leading-relaxed"
        data-testid={testId}
      >
        {shown}
      </pre>
      {foldable && (
        <Button
          className="w-fit self-start"
          data-u3-show-all
          size="xs"
          type="button"
          variant="outline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show fewer lines" : `Show all ${lines.length.toLocaleString("en-US")} lines`}
        </Button>
      )}
    </div>
  );
}
