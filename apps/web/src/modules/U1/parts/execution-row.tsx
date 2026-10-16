import { ChevronRightIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { ExecutionRecord } from "@/modules/U2/execution";

function statusOf(record: ExecutionRecord): string {
  if (record.cancelled) return "Cancelled";
  const status = record.exitCode === undefined ? "Finished" : `Exit code ${record.exitCode}`;
  return record.truncated ? `${status}, output shortened` : status;
}

function useScrollOverflow() {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const content = element.firstElementChild;
    if (content instanceof HTMLElement) observer.observe(content);
    return () => observer.disconnect();
  }, []);
  return { overflowing, ref };
}

/**
 * A user's own `!` or `$` run: its command, its output and how it ended. U2 normalizes omp's
 * record; the enclosing system surface supplies the frame, so the row adds none of its own.
 */
export function ExecutionRow({ record }: { readonly record: ExecutionRecord }) {
  const command = useScrollOverflow();
  const output = useScrollOverflow();
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
        {/* biome-ignore lint/a11y/useSemanticElements: the scroll block is a named group, not a landmark */}
        <div
          aria-label="Command"
          className="bg-background min-h-0 max-h-[10rem] overflow-auto rounded outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          ref={command.ref}
          role="group"
          tabIndex={command.overflowing ? 0 : undefined}
        >
          <pre className="text-foreground p-2 text-xs whitespace-pre-wrap break-words">
            {record.source}
          </pre>
        </div>
        {record.output !== "" && (
          <>
            {/* biome-ignore lint/a11y/useSemanticElements: the scroll block is a named group, not a landmark */}
            <div
              aria-label="Output"
              className="bg-background min-h-0 max-h-[15rem] overflow-auto rounded outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              ref={output.ref}
              role="group"
              tabIndex={output.overflowing ? 0 : undefined}
            >
              <pre
                className="text-foreground p-2 text-xs whitespace-pre-wrap break-words"
                data-testid="u1-execution-output"
              >
                {record.output}
              </pre>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
