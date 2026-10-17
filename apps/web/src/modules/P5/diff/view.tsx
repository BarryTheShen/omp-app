import type { AppError, CheckpointDiff } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { PanelShell } from "../../U5/panel/shell";
import { createDiffViewModel } from "./model";

export type DiffPanelProps = {
  readonly diff: CheckpointDiff | null;
  readonly loadState: "loading" | "empty" | "error" | "ready";
  readonly error?: AppError | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRetry?: () => void | Promise<void>;
};

export function DiffPanel({ diff, loadState, error, open, onOpenChange, onRetry }: DiffPanelProps) {
  const model = diff ? createDiffViewModel(diff) : null;
  const lifecycle =
    loadState === "ready" && !model ? "empty" : loadState === "ready" ? "populated" : loadState;
  const panelError =
    lifecycle === "error"
      ? (error ??
        new AppFailure({
          code: "internal",
          message: "Workspace changes could not be loaded.",
          retryable: true,
        }).appError)
      : null;
  return (
    <PanelShell
      state={{
        open,
        lifecycle,
        position: "right",
        title: "Workspace changes",
        description: "Review what differs before restoring a workspace.",
        error: panelError,
        readOnly: true,
        pendingUpdates: 0,
      }}
      onOpenChange={(next) => onOpenChange(next)}
      onRetry={onRetry}
      body={
        model ? (
          <div className="flex flex-col gap-3 p-4 text-sm">
            <p className="font-medium">{model.summary}</p>
            {model.entries.map((entry) => (
              <div className="border-border/60 rounded-md border p-3" key={entry.path}>
                <p className="font-medium">{entry.path}</p>
                <p className="text-muted-foreground">{entry.change}</p>
              </div>
            ))}
            {model.externalChanges.map((change) => (
              <div
                className="border-warning/30 bg-warning/10 rounded-md border p-3"
                key={change.path}
              >
                <p className="font-medium">Changed outside the restore point: {change.path}</p>
                <p className="text-muted-foreground">{change.change}</p>
              </div>
            ))}
            {model.excludedPaths.map((item) => (
              <div className="text-muted-foreground rounded-md border p-3" key={item.path}>
                Excluded: {item.path} — {item.reason}
              </div>
            ))}
          </div>
        ) : loadState === "empty" ? (
          <p className="p-4 text-sm">No file changes were found.</p>
        ) : null
      }
    />
  );
}
