import { useState } from "react";
import { InlineError } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  applyStatusLabel,
  SETTINGS_CONFLICT_DESCRIPTION,
  SETTINGS_CONFLICT_HEADING,
  SettingsSection,
  saveLocationText,
  UnsavedSettingsNotice,
} from "../../S1/settings-kit";
import type {
  MemorySettingsActions,
  MemorySettingsSectionState,
  MemorySettingsViewModel,
} from "./controller";

export type MemorySettingsViewProps = {
  readonly model: MemorySettingsViewModel;
  readonly actions: MemorySettingsActions;
  readonly onClose?: () => void;
};

function SectionState({
  state,
  actions,
}: {
  readonly state: MemorySettingsSectionState;
  readonly actions: MemorySettingsActions;
}) {
  const snapshot = state.snapshot;
  const [secretKey, setSecretKey] = useState<string | null>(null);
  const [secretText, setSecretText] = useState("");
  if (!snapshot.config || !snapshot.staged) {
    return (
      <section
        className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-5 text-card-foreground"
        data-testid={`memory-settings-${state.descriptor.id}`}
      >
        <h2 className="text-lg font-semibold tracking-tight">{state.descriptor.title}</h2>
        <p
          className="text-muted-foreground text-sm"
          role={snapshot.phase === "error" ? "alert" : "status"}
        >
          {snapshot.error?.message ?? "Loading settings…"}
        </p>
        {snapshot.phase === "error" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => actions.onRetry(state.descriptor.id)}
          >
            Retry
          </Button>
        ) : null}
      </section>
    );
  }
  const secretControl = state.descriptor.controls.find((control) => control.key === secretKey);
  const saveSecret = () => {
    const config = snapshot.config;
    if (!secretKey || secretText.length === 0 || !config) return;
    actions.onStage(state.descriptor.id, {
      snapshot: config,
      edits: { [secretKey]: { secret: true, action: "set", value: secretText } },
    });
    setSecretKey(null);
    setSecretText("");
  };
  return (
    <div data-testid={`memory-settings-${state.descriptor.id}`}>
      <p className="text-muted-foreground mb-3 text-xs">{saveLocationText(snapshot.layer)}</p>
      <SettingsSection
        descriptor={state.descriptor}
        snapshot={snapshot.config}
        staged={snapshot.staged}
        validation={state.validation}
        disabled={snapshot.phase === "loading" || snapshot.phase === "saving"}
        applyStatus={snapshot.applyStatus ? applyStatusLabel(snapshot.applyStatus) : undefined}
        unsavedKeys={snapshot.unsavedKeys}
        onStage={(staged) => actions.onStage(state.descriptor.id, staged)}
        onPreview={(key, result) => actions.onPreview(state.descriptor.id, key, result)}
        onSecretAction={(key, action) => {
          if (action === "set") {
            setSecretText("");
            setSecretKey(key);
          } else {
            actions.onSecretAction(state.descriptor.id, key, action);
          }
        }}
        onCommit={() => actions.onCommit(state.descriptor.id)}
        onCancel={() => actions.onCancel(state.descriptor.id)}
      />
      {secretControl && secretKey ? (
        <div className="mt-3 flex flex-col gap-2 rounded-lg border p-3" data-testid="secret-editor">
          <label className="text-sm font-medium" htmlFor={`${secretKey}-secret`}>
            {secretControl.label}
          </label>
          <Input
            id={`${secretKey}-secret`}
            type="password"
            value={secretText}
            onChange={(event) => setSecretText(event.target.value)}
            placeholder="Enter a new value"
          />
          <div className="flex gap-2">
            <Button type="button" onClick={saveSecret} disabled={secretText.length === 0}>
              Save credential
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setSecretKey(null);
                setSecretText("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {snapshot.unsavedKeys.length > 0 ? (
        <UnsavedSettingsNotice
          labels={snapshot.unsavedKeys.map(
            (key) =>
              state.descriptor.controls.find((control) => control.key === key)?.label ?? "Setting",
          )}
          reason="Some settings were not saved. Try Save changes again."
        />
      ) : null}
      {snapshot.conflict ? (
        <div
          className="mt-3 flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
          role="alert"
        >
          <p className="font-medium">{SETTINGS_CONFLICT_HEADING}</p>
          <p>{SETTINGS_CONFLICT_DESCRIPTION}</p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => actions.onResolveConflict(state.descriptor.id, "reload")}
            >
              Reload latest
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => actions.onResolveConflict(state.descriptor.id, "keep-mine")}
            >
              Keep my edits
            </Button>
          </div>
        </div>
      ) : null}
      {snapshot.error ? <InlineError message={snapshot.error.message} /> : null}
    </div>
  );
}

export function MemorySettingsView({ model, actions, onClose }: MemorySettingsViewProps) {
  const active =
    model.sections.find((section) => section.descriptor.id === model.activeSectionId) ??
    model.sections[0];
  return (
    <section className="bg-background text-foreground space-y-4 p-4 sm:p-6" data-i3-memory-settings>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="text-muted-foreground text-sm">Settings</p>
          <h1 className="text-2xl font-semibold tracking-tight">Memory</h1>
          <p className="text-muted-foreground text-sm">
            Memory backends, learning, recall and consolidation.
          </p>
        </div>
        {onClose ? (
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        ) : null}
      </header>
      <div className="flex flex-wrap gap-2" aria-label="Memory sections" role="tablist">
        {model.sections.map((section) => (
          <Button
            key={section.descriptor.id}
            type="button"
            role="tab"
            aria-selected={section.descriptor.id === model.activeSectionId}
            variant={section.descriptor.id === model.activeSectionId ? "default" : "outline"}
            onClick={() => actions.onSelectSection(section.descriptor.id)}
          >
            {section.descriptor.title}
          </Button>
        ))}
      </div>
      {active ? (
        <SectionState key={active.descriptor.id} state={active} actions={actions} />
      ) : (
        <p role="status">No memory settings are available.</p>
      )}
    </section>
  );
}
