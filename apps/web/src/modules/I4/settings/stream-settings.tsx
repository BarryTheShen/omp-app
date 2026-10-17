import type { JsonValue } from "@omp-app/contracts";
import { useEffect } from "react";
import { InlineError, Section, Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type { SettingsRuntime } from "@/modules/S1/runtime";
import { useSettingsRuntime } from "@/modules/S1/runtime";
import {
  applyStatusLabel,
  type ConfigSnapshot,
  SettingsSection,
  type SettingsSectionDescriptor,
  type SettingValue,
  type StagedSettings,
  settingLabels,
  UnsavedSettingsNotice,
} from "@/modules/S1/settings-kit";
import { STREAM_SETTINGS_SECTION } from "./stream-descriptor";

export interface StreamSettingsProps {
  readonly runtime: SettingsRuntime;
}

const PATTERN_KEY = "stream.redactPatterns";
const STREAM_SETTINGS_VIEW_SECTION: SettingsSectionDescriptor = {
  ...STREAM_SETTINGS_SECTION,
  controls: STREAM_SETTINGS_SECTION.controls.map((control) => {
    if (control.key !== PATTERN_KEY) return control;
    return {
      ...control,
      validate: (value, snapshot) => {
        if (value.secret || !Array.isArray(value.value)) return control.validate(value, snapshot);
        const normalized = value.value.map((item) => {
          if (
            item !== null &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            "pattern" in item
          ) {
            const pattern = item.pattern;
            return typeof pattern === "string" ? pattern : item;
          }
          return item;
        });
        return control.validate({ ...value, value: normalized }, snapshot);
      },
    };
  }),
};

function patternViewValue(value: JsonValue): JsonValue {
  if (!Array.isArray(value)) return value;
  return value.map((item) => (typeof item === "string" ? { pattern: item } : item));
}

function patternViewConfig(config: ConfigSnapshot): ConfigSnapshot {
  return {
    ...config,
    entries: config.entries.map((entry) =>
      entry.key === PATTERN_KEY && !entry.secret
        ? { ...entry, value: patternViewValue(entry.value) }
        : entry,
    ),
  };
}

function patternViewSetting(value: SettingValue): SettingValue {
  if (value.secret || !Array.isArray(value.value)) return value;
  return { ...value, value: patternViewValue(value.value) };
}

function patternViewStaged(staged: StagedSettings): StagedSettings {
  const edits: Record<string, SettingValue> = {};
  for (const [key, value] of Object.entries(staged.edits)) {
    edits[key] = key === PATTERN_KEY ? patternViewSetting(value) : value;
  }
  return {
    snapshot: patternViewConfig(staged.snapshot),
    edits,
  };
}

function storedPatternValue(value: SettingValue): SettingValue {
  if (value.secret || !Array.isArray(value.value)) return value;
  return {
    ...value,
    value: value.value.map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
      if ("pattern" in item) {
        const pattern = item.pattern;
        return typeof pattern === "string" ? pattern : item;
      }
      return item;
    }),
  };
}

function runtimeValue(key: string, value: SettingValue): SettingValue {
  return key === PATTERN_KEY ? storedPatternValue(value) : value;
}

/** ConfigStore-backed Stream settings; S1 owns the editor/runtime grammar. */
export function StreamSettings({ runtime }: StreamSettingsProps) {
  const state = useSettingsRuntime(runtime);
  useEffect(() => {
    if (state.config === null && state.phase === "idle") {
      void runtime.read().catch(() => undefined);
    }
  }, [runtime, state.config, state.phase]);

  if (state.config === null || state.staged === null) {
    return (
      <section
        aria-labelledby={`${STREAM_SETTINGS_SECTION.id}-loading-title`}
        className="flex min-h-40 flex-col gap-3 rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm"
      >
        <h2
          id={`${STREAM_SETTINGS_SECTION.id}-loading-title`}
          className="text-lg font-semibold tracking-tight"
        >
          {STREAM_SETTINGS_SECTION.title}
        </h2>
        <p role={state.error ? "alert" : "status"} className="text-sm text-muted-foreground">
          {state.error?.message ?? "Loading stream settings…"}
        </p>
        {state.error ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => {
              void runtime.retry().catch(() => undefined);
            }}
          >
            Try again
          </Button>
        ) : null}
      </section>
    );
  }

  const config = patternViewConfig(state.config);
  const staged = patternViewStaged(state.staged);
  const disabled = state.phase === "loading" || state.phase === "saving" || state.conflict !== null;
  const unsavedLabels = settingLabels(STREAM_SETTINGS_SECTION, state.unsavedKeys);
  const status =
    state.conflict || !state.applyStatus ? undefined : applyStatusLabel(state.applyStatus);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SettingsSection
        descriptor={STREAM_SETTINGS_VIEW_SECTION}
        snapshot={config}
        staged={staged}
        disabled={disabled}
        validation={state.validation}
        applyStatus={status}
        unsavedKeys={state.unsavedKeys}
        onStage={(next) => {
          for (const [key, value] of Object.entries(next.edits)) {
            runtime.stage(key, runtimeValue(key, value));
          }
        }}
        onCommit={() => {
          void runtime.save().catch(() => undefined);
        }}
        onCancel={() => runtime.cancel()}
      />
      {state.conflict ? (
        <Section
          heading="Settings changed elsewhere"
          headingLevel={3}
          description="Another change arrived while this section was open. Reload the latest values or keep your edits."
        >
          <Toolbar ariaLabel="Conflict actions" alignment="start">
            <Button
              type="button"
              variant="outline"
              onClick={() => runtime.resolveConflict("reload")}
            >
              Reload latest
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => runtime.resolveConflict("keep-mine")}
            >
              Keep my edits
            </Button>
          </Toolbar>
        </Section>
      ) : unsavedLabels.length > 0 ? (
        <UnsavedSettingsNotice labels={unsavedLabels} reason={state.error?.message ?? ""} />
      ) : state.error ? (
        <InlineError message={state.error.message} variant="compact" />
      ) : null}
    </div>
  );
}
