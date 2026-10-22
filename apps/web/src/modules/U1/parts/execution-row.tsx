import { ChevronRightIcon } from "lucide-react";
import { useContext, useLayoutEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ExecutionRecord } from "@/modules/U2/execution";
import { Icons } from "@/tokens";
import { CommandCancelContext } from "../thread/turn-cancel";

function statusOf(record: ExecutionRecord): string {
  if (record.cancelled) return "Cancelled";
  const status = record.exitCode === undefined ? "Finished" : `Exit code ${record.exitCode}`;
  return record.truncated ? `${status}, output shortened` : status;
}

/**
 * Whether a scroll block overflows. A block can mount after its row (a `!` output appears when its command ends), so it is
 * measured each time its element is set, and again as its size changes.
 */
function useScrollOverflow() {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    if (element === null) {
      setOverflowing(false);
      return;
    }
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const content = element.firstElementChild;
    if (content instanceof HTMLElement) observer.observe(content);
    return () => observer.disconnect();
  }, [element]);
  return { overflowing, ref: setElement };
}

/**
 * A user's own `!` or `$` run: its command, its output and how it ended. U2 normalizes omp's
 * record; the enclosing system surface supplies the frame, so the row adds none of its own.
 */
export function ExecutionRow({
  record,
  state,
}: {
  readonly record: ExecutionRecord;
  /** Running: the row says so and offers Stop command. Ended: omp gave no answer, so the row says Ended. Unset: finished. */
  readonly state?: "running" | "ended";
}) {
  const cancelCommand = useContext(CommandCancelContext);
  const command = useScrollOverflow();
  const output = useScrollOverflow();
  const label = record.mode === "bash" ? "Bash" : "Python";
  const statusText =
    state === "running" ? "Running" : state === "ended" ? "Ended" : statusOf(record);
  return (
    <details className="group text-sm" data-mode={record.mode} data-slot="u1-execution-row" open>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-xs">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform duration-(--duration-base) motion-reduce:transition-none group-open:rotate-90"
        />
        <span className="text-foreground font-medium">{label}</span>
        <span className="text-muted-foreground">{statusText}</span>
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
        {state === "running" && cancelCommand !== undefined && (
          <div>
            <Button
              aria-label="Stop command"
              size="sm"
              type="button"
              variant="outline"
              onClick={() => void cancelCommand()}
            >
              <Icons.stop aria-hidden="true" />
              Stop command
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}
