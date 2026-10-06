import { Button } from "@/components/ui/button";
import { SettingsSection } from "../../S1/settings-kit";
import type { FilesSettingsActions, FilesSettingsViewState } from "./controller";

export type FilesSettingsSectionProps = {
  readonly state: FilesSettingsViewState;
  readonly actions: FilesSettingsActions;
};

function FilesSettingsSectionView({ state, actions }: FilesSettingsSectionProps) {
  if (state.kind !== "ready") {
    const titleId = `${state.id}-loading-title`;
    return (
      <section
        aria-labelledby={titleId}
        className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-5 text-card-foreground shadow-sm"
        data-testid={`settings-view-${state.id}`}
      >
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">
          {state.title}
        </h2>
        <p
          role={state.kind === "unavailable" ? "alert" : "status"}
          className="text-sm text-muted-foreground"
        >
          {state.message}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={state.retryDisabled}
          onClick={actions.onRetry}
        >
          Retry
        </Button>
      </section>
    );
  }

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-testid={`settings-view-${state.descriptor.id}`}
    >
      <SettingsSection
        descriptor={state.descriptor}
        snapshot={state.config}
        staged={state.staged}
        disabled={state.disabled}
        validation={state.validation}
        applyStatus={state.applyStatus}
        onStage={actions.onStage}
        onPreview={actions.onPreview}
        onCommit={actions.onCommit}
        onCancel={actions.onCancel}
      />
      {state.conflict ? (
        <div
          role="alert"
          className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
        >
          <div className="text-warning-foreground">
            <p>
              Another change arrived. Review the current effective values, then reload them or keep
              your edits and save again.
            </p>
            <ul className="mt-2 flex flex-col gap-1">
              {state.conflict.rows.map((row) => (
                <li key={row.label}>
                  <strong>{row.label}:</strong> {row.value} · Source: {row.provenance}
                </li>
              ))}
            </ul>
          </div>
          <span className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => actions.onResolveConflict("reload")}
            >
              Reload
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => actions.onResolveConflict("keep-mine")}
            >
              Keep mine
            </Button>
          </span>
        </div>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error} Your edits remain staged; review them and try Save changes again.
        </p>
      ) : null}
    </div>
  );
}

export function FilesEditingSection(props: FilesSettingsSectionProps) {
  return <FilesSettingsSectionView {...props} />;
}

export function FilesReadingSection(props: FilesSettingsSectionProps) {
  return <FilesSettingsSectionView {...props} />;
}

export function FilesReadSummariesSection(props: FilesSettingsSectionProps) {
  return <FilesSettingsSectionView {...props} />;
}
