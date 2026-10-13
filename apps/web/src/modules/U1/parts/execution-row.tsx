import { ChevronRightIcon } from "lucide-react";
import type { ExecutionRecord } from "@/modules/U2/execution";

function statusOf(record: ExecutionRecord): string {
  if (record.cancelled) return "Cancelled";
  const status = record.exitCode === undefined ? "Finished" : `Exit code ${record.exitCode}`;
  return record.truncated ? `${status}, output shortened` : status;
}

/**
 * A user's own `!` or `$` run: its command, its output and how it ended. U2 normalizes omp's
 * record; the enclosing system surface supplies the frame, so the row adds none of its own.
 */
export function ExecutionRow({ record }: { readonly record: ExecutionRecord }) {
  const label = record.mode === "bash" ? "Bash" : "Python";
  return (
    <details className="group text-sm" data-mode={record.mode} data-slot="u1-execution-row" open>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-xs">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform duration-(--duration-base) motion-reduce:transition-none group-open:rotate-90"
        />
        <span className="text-foreground font-medium">{label}</span>
        <span className="text-muted-foreground">{statusOf(record)}</span>
        {record.excludeFromContext && (
          <span className="text-muted-foreground">Not sent to the model</span>
        )}
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <section
          aria-label="Command"
          className="bg-background max-h-40 overflow-auto rounded"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable block must take focus so a keyboard user can scroll it (WCAG 2.1.1)
          tabIndex={0}
        >
          <pre className="text-foreground p-2 text-xs whitespace-pre-wrap break-words">
            {record.source}
          </pre>
        </section>
        {record.output !== "" && (
          <section
            aria-label="Output"
            className="bg-background max-h-60 overflow-auto rounded"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable block must take focus so a keyboard user can scroll it (WCAG 2.1.1)
            tabIndex={0}
          >
            <pre
              className="text-foreground p-2 text-xs whitespace-pre-wrap break-words"
              data-testid="u1-execution-output"
            >
              {record.output}
            </pre>
          </section>
        )}
      </div>
    </details>
  );
}
