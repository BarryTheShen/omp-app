import { InlineError } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type { D74CommandSurface } from "../prewalk/commands";

export interface SurfaceNoticeProps {
  readonly surface: D74CommandSurface;
  readonly onRetry?: () => void;
}

/** Shows omp's typed command outputs verbatim without interpreting their prose. */
export function SurfaceNotice({ surface, onRetry }: SurfaceNoticeProps) {
  if (surface.state === "unknown") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-sm" role="status">
          {surface.message}
        </p>
        {onRetry && (
          <Button className="self-start" onClick={onRetry} size="sm" variant="outline">
            Retry
          </Button>
        )}
      </div>
    );
  }
  if (surface.state === "error" || surface.state === "unavailable") {
    return (
      <InlineError
        heading={surface.state === "unavailable" ? "Commands unavailable" : "Command failed"}
        message={surface.message ?? "The app could not reach omp. Try again."}
        onRetry={surface.state === "error" ? onRetry : undefined}
        variant="compact"
      />
    );
  }
  if (surface.state === "complete") {
    const outputs = surface.result?.outputs ?? [];
    const keyCounts = new Map<string, number>();
    const outputRows = outputs.map((output) => {
      const base = output.emittedAt ?? output.text;
      const count = keyCounts.get(base) ?? 0;
      keyCounts.set(base, count + 1);
      return { key: `${base}-${count}`, text: output.text };
    });
    return outputs.length > 0 ? (
      <div className="flex min-w-0 flex-col gap-2" aria-label="Command output" role="status">
        {outputRows.map((output) => (
          <p
            className="text-muted-foreground whitespace-pre-wrap text-sm [overflow-wrap:anywhere]"
            key={output.key}
          >
            {output.text}
          </p>
        ))}
      </div>
    ) : (
      <p className="text-muted-foreground text-sm" role="status">
        omp ran the command but printed nothing, so the app cannot confirm it took effect.
      </p>
    );
  }
  if (surface.state === "requested") {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        Waiting for omp to answer.
      </p>
    );
  }
  return null;
}
