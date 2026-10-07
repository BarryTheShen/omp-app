import { useCallback, useSyncExternalStore } from "react";
import type { ContextUsagePort } from "../contract";

export function useContextSnapshot(port: ContextUsagePort) {
  const subscribe = useCallback(
    (listener: Parameters<ContextUsagePort["subscribe"]>[0]) => port.subscribe(listener),
    [port],
  );
  const getSnapshot = useCallback(() => port.getSnapshot(), [port]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The real percent, even above 100: a session over its window should say so. */
export function percentLabel(percent: number): string {
  return `${Math.round(Math.max(0, percent))}%`;
}

export function ContextMeter({ port }: { readonly port: ContextUsagePort }) {
  const snapshot = useContextSnapshot(port);
  const usage = snapshot.usage;
  return (
    <section
      aria-labelledby="p7-context-meter-title"
      className="bg-card text-card-foreground rounded-xl border border-border/70 p-4 shadow-sm"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="p7-context-meter-title" className="text-sm font-semibold">
            Context
          </h2>
          <p className="text-muted-foreground text-xs">Current prompt context window</p>
        </div>
        {snapshot.isCompacting ? (
          <span className="text-xs text-muted-foreground" role="status">
            Compacting…
          </span>
        ) : null}
      </div>
      {usage ? (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span>
              {usage.tokens.toLocaleString()} / {usage.contextWindow.toLocaleString()} tokens
            </span>
            <strong>{percentLabel(usage.percent)}</strong>
          </div>
          <div
            aria-label={`Context used ${percentLabel(usage.percent)}`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.min(100, usage.percent)}
            className="bg-muted h-2 overflow-hidden rounded-full"
            role="progressbar"
          >
            <div
              className="bg-primary h-full rounded-full transition-[width]"
              style={{ width: `${Math.max(0, Math.min(100, usage.percent))}%` }}
            />
          </div>
          <div className="flex justify-between gap-3 text-xs text-muted-foreground">
            <span>
              {snapshot.autoCompactionEnabled === true
                ? "Auto-compaction armed"
                : snapshot.autoCompactionEnabled === false
                  ? "Auto-compaction off"
                  : "Auto-compaction unavailable"}
            </span>
            {snapshot.tokensPerSecond !== null ? (
              <span>{snapshot.tokensPerSecond.toFixed(1)} tok/s</span>
            ) : null}
          </div>
        </div>
      ) : (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          Context usage is unavailable from this host.
        </p>
      )}
      {snapshot.error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {snapshot.error.message}
        </p>
      ) : null}
    </section>
  );
}
