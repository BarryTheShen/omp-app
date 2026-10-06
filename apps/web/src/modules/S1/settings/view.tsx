import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppearancePreview } from "../appearance/preview";
import { ShowImagesSelector, ThemeSelector } from "../appearance/selectors";
import { SettingsSection, saveLocationText } from "../settings-kit";
import type {
  AppearanceSettingsActions,
  AppearanceSettingsActiveSectionModel,
  AppearanceSettingsViewModel,
} from "./controller";

export type AppearanceSettingsViewProps = {
  readonly model: AppearanceSettingsViewModel;
  readonly actions: AppearanceSettingsActions;
  readonly onClose: () => void;
};

function statusLabel(status: string): string {
  return status.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
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
        applyStatus={section.applyStatus ? statusLabel(section.applyStatus) : undefined}
        onStage={(staged) => actions.onStage(section.descriptor.id, staged)}
        onPreview={actions.onPreview}
        onSecretAction={actions.onSecretAction}
        onCommit={() => actions.onCommit(section.descriptor.id)}
        onCancel={() => actions.onCancel(section.descriptor.id)}
      />
      {section.conflict ? (
        <div
          className="border-warning/50 bg-warning-surface rounded-lg border px-4 py-4"
          role="alert"
        >
          <p className="text-warning-surface-foreground text-sm">
            Another settings writer changed {section.conflict.changedKeys.join(", ")}.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => actions.onConflictChoice(section.descriptor.id, "reload")}
            >
              Reload latest
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => actions.onConflictChoice(section.descriptor.id, "keep-mine")}
            >
              Keep my edits
            </Button>
          </div>
        </div>
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

export function AppearanceSettingsView({ model, actions, onClose }: AppearanceSettingsViewProps) {
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
          onPreview={actions.onThemePreview}
          onSelect={actions.onThemeSelect}
          onCancel={actions.onCancelSelector}
        />
        <AppearancePreview model={model.preview} />
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
          onPreview={actions.onImagesPreview}
          onSelect={actions.onImagesSelect}
          onCancel={actions.onCancelSelector}
        />
        <AppearancePreview model={model.preview} />
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
      className="bg-background text-foreground space-y-4 p-4 sm:p-6"
      data-s1-appearance-settings
    >
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
        {model.sections.map((section) => (
          <Button
            key={section.id}
            id={`appearance-tab-${section.id}`}
            type="button"
            role="tab"
            aria-controls={`appearance-panel-${section.id}`}
            aria-selected={section.selected}
            variant={section.selected ? "default" : "outline"}
            onClick={() => actions.onSelectSection(section.id)}
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
          <AppearancePreview model={model.preview} />
        </div>
      )}
    </section>
  );
}
