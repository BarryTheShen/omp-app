import { ConflictBanner } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import {
  CONFLICT_BUTTON_LABELS,
  SETTINGS_CONFLICT_DESCRIPTION,
  SETTINGS_CONFLICT_HEADING,
  SettingsSection,
} from "../../S1/settings-kit";
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
        <ConflictBanner
          description={SETTINGS_CONFLICT_DESCRIPTION}
          heading={SETTINGS_CONFLICT_HEADING}
          keepMineLabel={CONFLICT_BUTTON_LABELS.keepMine}
          onKeepMine={() => actions.onResolveConflict("keep-mine")}
          onReload={() => actions.onResolveConflict("reload")}
          reloadLabel={CONFLICT_BUTTON_LABELS.reload}
          rows={state.conflict.rows}
        />
      ) : state.error ? (
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
