import { ConflictBanner } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShowImagesSelector, ThemeSelector } from "../appearance/selectors";
import {
  applyStatusLabel,
  CONFLICT_BUTTON_LABELS,
  SETTINGS_CONFLICT_DESCRIPTION,
  SETTINGS_CONFLICT_HEADING,
  SettingsSection,
  saveLocationText,
  UnsavedSettingsNotice,
} from "../settings-kit";
import type {
  AppearanceSettingsActions,
  AppearanceSettingsActiveSectionModel,
  AppearanceSettingsViewModel,
} from "./controller";

export type AppearanceSettingsViewProps = {
  readonly model: AppearanceSettingsViewModel;
  readonly actions: AppearanceSettingsActions;
  readonly onClose: () => void;
  /** Hide the standalone page heading when this view is embedded in another settings surface. */
  readonly showHeader?: boolean;
};
function AppearanceScopeNote() {
  return (
    <p className="text-muted-foreground text-sm">
      These settings change omp's terminal only, except Block Images and Auto-Resize Images, which
      also change this app's chats.
    </p>
  );
}

/** The tab an arrow, Home or End key moves to; wraps at either end. Undefined for other keys. */
function appearanceTabTarget(key: string, index: number, count: number): number | undefined {
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}

function ActiveSectionView({
  section,
  actions,
}: {
  readonly section: AppearanceSettingsActiveSectionModel;
  readonly actions: AppearanceSettingsActions;
}) {
  return (
    <div className="space-y-3" data-s1-appearance-section={section.descriptor.id}>
      <SettingsSection
        descriptor={section.descriptor}
        snapshot={section.snapshot}
        staged={section.staged}
        validation={section.validation}
        disabled={section.disabled}
        applyStatus={
          section.conflict || !section.applyStatus
            ? undefined
            : applyStatusLabel(section.applyStatus)
        }
        unsavedKeys={section.unsavedKeys}
        onStage={(staged) => actions.onStage(section.descriptor.id, staged)}
        onSecretAction={actions.onSecretAction}
        onCommit={() => actions.onCommit(section.descriptor.id)}
        onCancel={() => actions.onCancel(section.descriptor.id)}
      />
      {section.conflict ? (
        <ConflictBanner
          description={SETTINGS_CONFLICT_DESCRIPTION}
          heading={SETTINGS_CONFLICT_HEADING}
          keepMineLabel={CONFLICT_BUTTON_LABELS.keepMine}
          onKeepMine={() => actions.onConflictChoice(section.descriptor.id, "keep-mine")}
          onReload={() => actions.onConflictChoice(section.descriptor.id, "reload")}
          reloadLabel={CONFLICT_BUTTON_LABELS.reload}
          rows={section.conflictRows}
        />
      ) : section.unsavedLabels.length > 0 ? (
        <UnsavedSettingsNotice labels={section.unsavedLabels} reason={section.error ?? ""} />
      ) : section.error ? (
        <div
          className="border-destructive/50 bg-destructive/10 rounded-lg border px-4 py-3"
          role="alert"
        >
          <p className="text-destructive text-sm">{section.error}</p>
          <Button
            type="button"
            variant="outline"
            className="mt-3"
            onClick={() => actions.onRetrySection(section.descriptor.id)}
          >
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function AppearanceSettingsView({
  model,
  actions,
  onClose,
  showHeader = true,
}: AppearanceSettingsViewProps) {
  if (model.selector?.kind === "theme") {
    return (
      <section
        className="bg-background text-foreground space-y-4 p-4 sm:p-6"
        data-s1-appearance-settings
      >
        <Button type="button" variant="outline" onClick={actions.onCancelSelector}>
          Back to Appearance
        </Button>
        <ThemeSelector
          settingKey={model.selector.key}
          value={model.selector.value}
          onValueChange={actions.onThemeValueChange}
          onSelect={actions.onThemeSelect}
          onCancel={actions.onCancelSelector}
        />
        <AppearanceScopeNote />
        {model.actionError ? (
          <p className="text-destructive text-sm" role="alert">
            {model.actionError}
          </p>
        ) : null}
      </section>
    );
  }

  if (model.selector?.kind === "images") {
    return (
      <section
        className="bg-background text-foreground space-y-4 p-4 sm:p-6"
        data-s1-appearance-settings
      >
        <Button type="button" variant="outline" onClick={actions.onCancelSelector}>
          Back to Appearance
        </Button>
        <ShowImagesSelector
          value={model.selector.value}
          onSelect={actions.onImagesSelect}
          onCancel={actions.onCancelSelector}
        />
        <AppearanceScopeNote />
        {model.actionError ? (
          <p className="text-destructive text-sm" role="alert">
            {model.actionError}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section
      className={
        showHeader
          ? "bg-background text-foreground space-y-4 p-4 sm:p-6"
          : "text-foreground space-y-4"
      }
      data-s1-appearance-settings
    >
      {showHeader ? (
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <p className="text-muted-foreground text-sm">Settings</p>
            <h1 className="text-2xl font-semibold tracking-tight">Appearance</h1>
            <p className="text-muted-foreground text-sm">
              Theme, composer, status line, display, and image behavior.
            </p>
            <p className="text-muted-foreground text-xs">{saveLocationText(model.layer)}</p>
          </div>
          <Button type="button" variant="outline" onClick={onClose} aria-label="Close settings">
            Close
          </Button>
        </header>
      ) : null}
      <AppearanceScopeNote />

      <div className="space-y-3">
        <label className="text-sm font-medium" htmlFor="s1-appearance-search">
          Search settings
        </label>
        <Input
          id="s1-appearance-search"
          type="search"
          value={model.search}
          placeholder="Search appearance settings"
          onChange={(event) => actions.onSearch(event.target.value)}
        />
      </div>

      <div className="flex flex-wrap gap-2" aria-label="Appearance sections" role="tablist">
        {model.sections.map((section, index) => (
          <Button
            key={section.id}
            id={`appearance-tab-${section.id}`}
            type="button"
            role="tab"
            aria-controls={`appearance-panel-${section.id}`}
            aria-selected={section.selected}
            tabIndex={section.selected ? 0 : -1}
            variant={section.selected ? "default" : "outline"}
            onClick={() => actions.onSelectSection(section.id)}
            onKeyDown={(event) => {
              const target = appearanceTabTarget(event.key, index, model.sections.length);
              if (target === undefined) return;
              event.preventDefault();
              const next = model.sections[target];
              if (!next) return;
              actions.onSelectSection(next.id);
              document.getElementById(`appearance-tab-${next.id}`)?.focus();
            }}
          >
            {section.title}
          </Button>
        ))}
      </div>

      {model.loading ? (
        <p className="text-muted-foreground rounded-lg border px-4 py-6 text-sm" role="status">
          Loading appearance settings…
        </p>
      ) : model.loadError ? (
        <div
          className="border-destructive/50 bg-destructive/10 rounded-lg border px-4 py-4"
          role="alert"
        >
          <p className="text-destructive text-sm">{model.loadError}</p>
          <Button type="button" variant="outline" className="mt-3" onClick={actions.onRetryLoad}>
            Retry
          </Button>
        </div>
      ) : !model.activeSection ? (
        <p className="text-muted-foreground rounded-lg border px-4 py-6 text-sm" role="status">
          {model.emptyMessage}
        </p>
      ) : (
        <div
          id={`appearance-panel-${model.activeSection.descriptor.id}`}
          role="tabpanel"
          aria-labelledby={`appearance-tab-${model.activeSection.descriptor.id}`}
          className="space-y-4"
        >
          {model.activeSection.selectorActions === "theme" ? (
            <fieldset className="flex flex-wrap gap-2 border-0 p-0">
              <legend className="sr-only">Theme selectors</legend>
              <Button
                type="button"
                variant="outline"
                onClick={() => actions.onOpenThemeSelector("theme.dark")}
              >
                Choose dark theme…
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => actions.onOpenThemeSelector("theme.light")}
              >
                Choose light theme…
              </Button>
            </fieldset>
          ) : null}
          {model.activeSection.selectorActions === "images" ? (
            <Button type="button" variant="outline" onClick={actions.onOpenImagesSelector}>
              Show images selector…
            </Button>
          ) : null}
          <ActiveSectionView section={model.activeSection} actions={actions} />
        </div>
      )}
    </section>
  );
}
