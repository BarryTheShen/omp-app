import type { ContextUsagePort, UsageLimitsSource, UsagePort } from "../contract";
import { UsagePopover } from "../usage";
import { percentLabel, useContextSnapshot } from "./context-meter";

/** Tokens as a short count: 950, 12.4k, 128k, 1.2M. */
function shortCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) {
    const thousands = tokens / 1_000;
    return `${thousands < 100 ? thousands.toFixed(1).replace(/\.0$/, "") : Math.round(thousands)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * One status-bar line: context used against the window, compaction in progress, and the usage
 * popover. The full context card (`ContextMeter`) belongs in a panel.
 */
export function ContextStatusBar({
  context,
  usage,
  limits,
  isStreaming,
}: {
  readonly context: ContextUsagePort;
  readonly usage: UsagePort;
  readonly limits: UsageLimitsSource;
  readonly isStreaming: boolean;
}) {
  const snapshot = useContextSnapshot(context);
  const window = snapshot.usage;
  return (
    <section
      aria-label="Context status"
      className="text-muted-foreground flex min-w-0 items-center gap-3 text-meta"
    >
      {window ? (
        <span className="flex min-w-0 items-center gap-2">
          {/* The meter is dropped below 28 rem (448 px) of status bar, so the words and Usage keep their room (issue 1607). */}
          <span className="shrink-0">Context {percentLabel(window.percent)}</span>
          <span
            aria-label={`Context used ${percentLabel(window.percent)}`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.min(100, window.percent)}
            className="bg-muted hidden h-1.5 w-20 shrink-0 overflow-hidden rounded-full @md:block"
            role="progressbar"
          >
            <span
              className="bg-primary block h-full rounded-full transition-[width]"
              style={{ width: `${Math.max(0, Math.min(100, window.percent))}%` }}
            />
          </span>
          <span className="truncate">
            {shortCount(window.tokens)} of {shortCount(window.contextWindow)} tokens
          </span>
        </span>
      ) : (
        <span>Context usage unavailable</span>
      )}
      {snapshot.isCompacting ? <span role="status">Compacting…</span> : null}
      {isStreaming && snapshot.tokensPerSecond !== null ? (
        <span>{snapshot.tokensPerSecond.toFixed(1)} tokens/s</span>
      ) : null}
      <UsagePopover port={usage} limits={limits} />
    </section>
  );
}
