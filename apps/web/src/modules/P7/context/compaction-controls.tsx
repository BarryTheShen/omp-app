import { useCallback, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { CompactionPort } from "../contract";

function useCompactionSnapshot(port: CompactionPort) {
  const subscribe = useCallback(
    (listener: Parameters<CompactionPort["subscribe"]>[0]) => port.subscribe(listener),
    [port],
  );
  const getSnapshot = useCallback(() => port.getSnapshot(), [port]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function CompactionControls({ port }: { readonly port: CompactionPort }) {
  const snapshot = useCompactionSnapshot(port);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = snapshot.phase === "running";
  const compact = async () => {
    setBusy(true);
    setError(null);
    try {
      await port.compact();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Compaction failed.");
    } finally {
      setBusy(false);
    }
  };
  const toggleAuto = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await port.setAutoCompaction({ enabled });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Updating auto-compaction failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-labelledby="p7-compaction-title"
      className="bg-card text-card-foreground rounded-xl border border-border/70 p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="p7-compaction-title" className="text-sm font-semibold">
            Compaction
          </h2>
          <p className="text-muted-foreground text-xs">
            Reduce context while preserving the session state.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || running}
          onClick={() => void compact()}
        >
          {running ? "Compacting…" : "Compact now"}
        </Button>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={snapshot.auto}
          disabled={busy}
          onChange={(event) => void toggleAuto(event.currentTarget.checked)}
        />
        <span>Auto-compaction</span>
      </label>
      {snapshot.phase === "completed" && snapshot.result ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          Compacted {snapshot.result.tokensBefore.toLocaleString()} tokens.
        </p>
      ) : null}
      {snapshot.phase === "skipped" ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          Compaction was skipped.
        </p>
      ) : null}
      {snapshot.phase === "aborted" ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          Compaction was cancelled.
        </p>
      ) : null}
      {snapshot.error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {snapshot.error.message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
