import { useEffect, useMemo, useRef, useState } from "react";
import { InlineError, Section, SettingRow } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { useDisposeWhenReplaced } from "@/modules/U4/host";
import {
  applyStatusLabel,
  CONFLICT_BUTTON_LABELS,
  environmentOverrideText,
  SETTINGS_CONFLICT_DESCRIPTION,
  SettingsSection,
  saveLocationText,
  settingLabels,
  UnsavedSettingsNotice,
} from "../../S1/settings-kit";
import { type ProviderSettingsController, useSettingsRuntime } from "./controller";

export type ProviderSettingsPanelProps = {
  readonly controller: ProviderSettingsController;
};

type SectionError = {
  readonly kind: "load" | "save";
  readonly message: string;
};

function capabilityReason(controller: ProviderSettingsController): string | undefined {
  const status = controller.capabilities["host.config"];
  return status?.state === "available"
    ? undefined
    : (status?.detail ?? "Provider settings are unavailable for this session.");
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function ProviderSettingsPanel({ controller }: ProviderSettingsPanelProps) {
  const [activeId, setActiveId] = useState(controller.selectedSectionId);
  const [activeLayer, setActiveLayer] = useState(controller.layer);
  const [sectionErrors, setSectionErrors] = useState<Record<string, SectionError>>({});
  const [tabError, setTabError] = useState<string | undefined>();
  const selectedId = activeId;
  const runtime = controller.runtime(selectedId);
  const snapshot = useSettingsRuntime(runtime);
  const reason = capabilityReason(controller);
  const descriptors = controller.descriptors;
  const selected = useMemo(
    () => descriptors.find((descriptor) => descriptor.id === selectedId) ?? descriptors[0],
    [descriptors, selectedId],
  );
  const dirty = snapshot.staged !== null && Object.keys(snapshot.staged.edits).length > 0;
  const sectionError = sectionErrors[selectedId];
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useDisposeWhenReplaced(controller);

  useEffect(() => {
    if (reason) return;
    const phase = runtime.getSnapshot().phase;
    if (phase !== "idle" && phase !== "error") return;
    void runtime.read().catch((error: unknown) => {
      setSectionErrors((current) => ({
        ...current,
        [selectedId]: {
          kind: "load",
          message: errorText(error, "Provider settings could not be loaded."),
        },
      }));
    });
  }, [reason, runtime, selectedId]);

  if (!selected) return null;
  const sectionTabId = (id: string) => `provider-settings-tab-${id.replaceAll(".", "-")}`;
  const sectionPanelId = (id: string) => `provider-settings-panel-${id.replaceAll(".", "-")}`;
  const unsavedLabels = settingLabels(selected, snapshot.unsavedKeys);

  const selectSection = (nextId: string): boolean => {
    if (nextId === selected.id) return true;
    if (dirty) {
      setTabError("Save or cancel these changes before switching sections.");
      return false;
    }
    setSectionErrors({});
    setTabError(undefined);
    controller.select(nextId);
    setActiveId(nextId);
    return true;
  };

  const moveTab = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const currentIndex = descriptors.findIndex((descriptor) => descriptor.id === selected.id);
    let nextIndex: number;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % descriptors.length;
    else if (event.key === "ArrowLeft")
      nextIndex = (currentIndex - 1 + descriptors.length) % descriptors.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = descriptors.length - 1;
    else return;
    event.preventDefault();
    const next = descriptors[nextIndex];
    if (next && selectSection(next.id)) tabRefs.current[next.id]?.focus();
  };

  const selectLayer = (nextLayer: "global" | "project"): void => {
    if (dirty && nextLayer !== activeLayer) {
      setTabError("Save or cancel these changes before changing the save location.");
      return;
    }
    setTabError(undefined);
    setSectionErrors({});
    controller.selectLayer(nextLayer);
    setActiveLayer(nextLayer);
  };

  const retry = (): void => {
    setSectionErrors((current) => {
      const next = { ...current };
      delete next[selectedId];
      return next;
    });
    void runtime.retry().catch((error: unknown) => {
      setSectionErrors((current) => ({
        ...current,
        [selectedId]: {
          kind: "load",
          message: errorText(error, "Provider settings could not be loaded."),
        },
      }));
    });
  };

  const save = (): void => {
    setSectionErrors((current) => {
      const next = { ...current };
      delete next[selectedId];
      return next;
    });
    void runtime.save().catch((error: unknown) => {
      if (runtime.getSnapshot().phase === "conflict") return;
      setSectionErrors((current) => ({
        ...current,
        [selectedId]: {
          kind: "save",
          message: errorText(error, "Provider settings could not be saved."),
        },
      }));
    });
  };

  const resolveConflict = (choice: "reload" | "keep-mine"): void => {
    setSectionErrors((current) => {
      const next = { ...current };
      delete next[selectedId];
      return next;
    });
    runtime.resolveConflict(choice);
  };

  const changeLayer = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    selectLayer(event.currentTarget.value as "global" | "project");
  };

  return (
    <div className="space-y-4" data-testid="provider-settings-panel">
      <Section
        heading="Provider settings"
        description="Choose a settings section and where its changes will be saved."
      >
        <SettingRow
          title="Save location"
          description={saveLocationText(activeLayer)}
          layout="stacked"
        >
          <select
            aria-label="Save location"
            className="border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-fit min-w-40 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-2"
            disabled={reason !== undefined || (dirty && snapshot.phase !== "ready")}
            onChange={changeLayer}
            value={activeLayer}
          >
            <option value="global">All projects</option>
            <option value="project" disabled={!controller.canSaveToProject()}>
              This project
            </option>
          </select>
        </SettingRow>
        <div
          className="flex flex-wrap gap-2"
          role="tablist"
          aria-label="Provider settings sections"
        >
          {descriptors.map((descriptor) => (
            <Button
              key={descriptor.id}
              id={sectionTabId(descriptor.id)}
              ref={(node) => {
                tabRefs.current[descriptor.id] = node;
              }}
              type="button"
              variant={descriptor.id === selected.id ? "default" : "outline"}
              size="sm"
              role="tab"
              aria-selected={descriptor.id === selected.id}
              aria-controls={sectionPanelId(descriptor.id)}
              tabIndex={descriptor.id === selected.id ? 0 : -1}
              onClick={() => selectSection(descriptor.id)}
              onKeyDown={moveTab}
            >
              {descriptor.title}
            </Button>
          ))}
        </div>
        {tabError ? <p role="alert">{tabError}</p> : null}
      </Section>

      {reason ? (
        <InlineError heading="Provider settings are unavailable" message={reason} variant="boxed" />
      ) : snapshot.phase === "loading" || snapshot.phase === "idle" ? (
        <p role="status">Loading provider settings…</p>
      ) : snapshot.phase === "error" && (!snapshot.config || !snapshot.staged) ? (
        <InlineError
          heading="Provider settings could not be loaded"
          message={
            sectionError?.kind === "load"
              ? sectionError.message
              : (snapshot.error?.message ?? "Try again.")
          }
          onRetry={retry}
          variant="boxed"
        />
      ) : snapshot.config && snapshot.staged ? (
        <div
          id={sectionPanelId(selected.id)}
          role="tabpanel"
          aria-labelledby={sectionTabId(selected.id)}
        >
          <SettingsSection
            descriptor={selected}
            snapshot={snapshot.config}
            staged={snapshot.staged}
            disabled={snapshot.phase === "saving" || snapshot.phase === "conflict"}
            validation={snapshot.validation}
            applyStatus={snapshot.applyStatus ? applyStatusLabel(snapshot.applyStatus) : undefined}
            notice={
              snapshot.environmentOverride
                ? environmentOverrideText(snapshot.environmentOverride)
                : undefined
            }
            unsavedKeys={snapshot.unsavedKeys}
            onStage={(next) => {
              const previous = snapshot.staged?.edits ?? {};
              for (const [key, value] of Object.entries(next.edits)) {
                if (JSON.stringify(previous[key]) !== JSON.stringify(value))
                  runtime.stage(key, value);
              }
            }}
            onCommit={save}
            onCancel={() => {
              setSectionErrors((current) => {
                const next = { ...current };
                delete next[selectedId];
                return next;
              });
              runtime.cancel();
            }}
          />
          {snapshot.conflict ? (
            <InlineError
              heading="Settings changed elsewhere"
              message={SETTINGS_CONFLICT_DESCRIPTION}
              actions={
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => resolveConflict("reload")}>
                    {CONFLICT_BUTTON_LABELS.reload}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => resolveConflict("keep-mine")}>
                    {CONFLICT_BUTTON_LABELS.keepMine}
                  </Button>
                </div>
              }
              variant="boxed"
            />
          ) : unsavedLabels.length > 0 ? (
            <UnsavedSettingsNotice
              labels={unsavedLabels}
              reason={
                sectionError?.kind === "save"
                  ? sectionError.message
                  : (snapshot.error?.message ?? "Try saving again.")
              }
            />
          ) : sectionError?.kind === "save" ? (
            <InlineError
              heading="Provider settings could not be saved"
              message={sectionError.message}
              variant="compact"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export { ProviderSettingsPanel };
