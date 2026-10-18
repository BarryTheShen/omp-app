import { AppFailure, type JsonValue } from "@omp-app/contracts";
import { useMemo, useState, useSyncExternalStore } from "react";
import { ConflictBanner, InlineError, SettingRow } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveLocationText } from "@/modules/S1/settings-kit";
import { checkboxRowLook, SELECT_DISABLED_LOOK } from "@/modules/S1/settings-kit/control-look";
import type { AdvisorConfigController, AdvisorConfigState } from "./advisor";
import {
  type AdvisorConfigRowViewModel,
  type AdvisorSettingDefinition,
  advisorConfigView,
} from "./model";

export interface AdvisorConfigurationViewProps {
  readonly state: AdvisorConfigState;
  readonly controller: AdvisorConfigController;
  readonly onClose?: () => void;
  readonly onRetryConflict?: () => void | Promise<void>;
}

type DraftValue = string | boolean;

function draftValue(value: JsonValue): DraftValue {
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function valueFor(definition: AdvisorSettingDefinition, draft: DraftValue): JsonValue {
  if (definition.kind === "boolean") return draft === true || draft === "true";
  if (definition.kind === "number") return Number(draft);
  return String(draft);
}

function SettingControl({
  row,
  draft,
  setDraft,
  save,
  saving,
}: {
  readonly row: AdvisorConfigRowViewModel;
  readonly draft: DraftValue;
  readonly setDraft: (value: DraftValue) => void;
  readonly save: () => void;
  readonly saving: boolean;
}) {
  const { definition } = row;
  const saveLabel = `Save ${definition.label}`;
  if (definition.kind === "boolean") {
    return (
      <div className="flex items-center gap-2">
        <label className={checkboxRowLook(saving)}>
          <input
            type="checkbox"
            checked={draft === true || draft === "true"}
            aria-label={definition.label}
            disabled={saving}
            onChange={(event) => setDraft(event.currentTarget.checked)}
          />
          <span>{draft === true || draft === "true" ? "On" : "Off"}</span>
        </label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving}
          aria-label={saveLabel}
          onClick={save}
        >
          Save
        </Button>
      </div>
    );
  }
  if (definition.kind === "select") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={definition.label}
          className={`border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-36 shrink-0 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-2 ${SELECT_DISABLED_LOOK}`}
          value={String(draft)}
          disabled={saving}
          style={{ color: "var(--foreground)", WebkitTextFillColor: "var(--foreground)" }}
          onChange={(event) => setDraft(event.currentTarget.value)}
        >
          {(definition.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving}
          aria-label={saveLabel}
          onClick={save}
        >
          Save
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        aria-label={definition.label}
        className="text-foreground w-28 shrink-0"
        inputMode="numeric"
        min={1}
        step={1}
        type="number"
        value={String(draft)}
        disabled={saving}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={saving}
        aria-label={saveLabel}
        onClick={save}
      >
        Save
      </Button>
    </div>
  );
}

function SettingRowView({
  row,
  draft,
  setDraft,
  save,
  saving,
}: {
  readonly row: AdvisorConfigRowViewModel;
  readonly draft: DraftValue;
  readonly setDraft: (value: DraftValue) => void;
  readonly save: () => void;
  readonly saving: boolean;
}) {
  const source = row.provenanceLabel
    ? `${row.sourceLabel} · ${row.provenanceLabel}`
    : row.sourceLabel;
  return (
    <SettingRow
      title={row.definition.label}
      description={row.definition.description}
      detail={row.overridesLabel ? `${source}. ${row.overridesLabel}.` : `${source}.`}
      layout="beside"
    >
      <SettingControl row={row} draft={draft} setDraft={setDraft} save={save} saving={saving} />
    </SettingRow>
  );
}

/** The settings surface used inside the app shell or an app-origin U4 dialog. */
function AdvisorConfigurationView({
  state,
  controller,
  onClose,
  onRetryConflict,
}: AdvisorConfigurationViewProps) {
  const liveState = useSyncExternalStore(controller.subscribe, controller.getSnapshot, () => state);
  const model = useMemo(() => advisorConfigView(liveState), [liveState]);
  const [drafts, setDrafts] = useState<Record<string, DraftValue>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictedKey, setConflictedKey] = useState<string | null>(null);

  const save = async (row: AdvisorConfigRowViewModel, retry = false): Promise<void> => {
    const key = row.definition.key;
    const draft = drafts[key] ?? draftValue(row.value);
    try {
      if (retry) await controller.read();
      await controller.write(key, valueFor(row.definition, draft));
      setConflictedKey(null);
    } catch (error) {
      if (error && typeof error === "object" && "appError" in error) {
        const failure = error as {
          readonly appError: { readonly code: string; readonly message: string };
        };
        if (failure.appError.code === "conflict") setConflictedKey(key);
        setSaveError(failure.appError.message);
      } else {
        setSaveError("This setting could not be saved. Try again.");
      }
    } finally {
      setSavingKey(null);
    }
  };

  const reloadSettings = async (): Promise<void> => {
    try {
      await controller.read();
      setDrafts({});
      setSaveError(null);
      setConflictedKey(null);
    } catch (error) {
      setSaveError(
        error instanceof AppFailure
          ? error.appError.message
          : "Advisor settings could not be reloaded.",
      );
    }
  };

  const retryConflict = async (): Promise<void> => {
    if (onRetryConflict) {
      await onRetryConflict();
      return;
    }
    const row = model.rows.find((candidate) => candidate.definition.key === conflictedKey);
    if (row) await save(row, true);
  };

  return (
    <section aria-label="Advisor settings" className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-base">Advisor settings</h2>
          <p className="mt-1 text-muted-foreground text-sm">{saveLocationText(liveState.layer)}</p>
          <p className="mt-1 text-muted-foreground text-xs">
            Each change is checked against the latest settings revision.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={liveState.phase === "loading"}
            onClick={() => void reloadSettings()}
          >
            Reload
          </Button>
          {onClose ? (
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          ) : null}
        </div>
      </header>

      {liveState.phase === "loading" ? (
        <p className="text-muted-foreground text-sm">Loading advisor settings…</p>
      ) : null}
      {liveState.phase === "error" && liveState.error ? (
        <InlineError
          heading="Advisor settings could not be loaded"
          message={liveState.error.appError.message}
          onRetry={() => void reloadSettings()}
        />
      ) : null}
      {liveState.phase === "conflict" && liveState.error ? (
        <ConflictBanner
          heading="These settings changed elsewhere"
          description="Reload the settings before saving again, or retry your latest choice against the newest revision."
          reloadLabel="Reload settings"
          keepMineLabel="Try saving again"
          rows={[]}
          onReload={() => void reloadSettings()}
          onKeepMine={retryConflict}
        />
      ) : null}
      {saveError && liveState.phase !== "conflict" ? (
        <InlineError heading="Advisor setting was not saved" message={saveError} />
      ) : null}
      {liveState.phase !== "loading" ? (
        <div className="space-y-2">
          {model.rows.map((row) => (
            <SettingRowView
              key={row.definition.key}
              row={row}
              draft={drafts[row.definition.key] ?? draftValue(row.value)}
              setDraft={(value) => {
                setSaveError(null);
                setDrafts((current) => ({ ...current, [row.definition.key]: value }));
              }}
              save={() => void save(row)}
              saving={savingKey === row.definition.key || liveState.phase === "saving"}
            />
          ))}
        </div>
      ) : null}
      {liveState.phase === "ready" ? (
        <p className="text-muted-foreground text-xs">Settings are up to date.</p>
      ) : null}
    </section>
  );
}

export { AdvisorConfigurationView };
