import type { ConfigEntry } from "@omp-app/contracts";
import { type ReactNode, useState } from "react";
import { InlineError, Section, SettingRow, Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  ConfigSnapshot,
  PreviewResult,
  ScalarSettingControl,
  SettingControl,
  SettingsSectionDescriptor,
  SettingValue,
  StagedSettings,
  ValidationResult,
} from "./grammar";
import {
  effectiveEntry,
  provenanceLabel,
  secretSummary,
  settingSourceLabel,
  stage,
} from "./grammar";
import { isStructuredControl, ReadOnlyValue, StructuredEditor } from "./structured";

export type SettingsSectionProps = {
  readonly descriptor: SettingsSectionDescriptor;
  readonly snapshot: ConfigSnapshot;
  readonly staged?: StagedSettings;
  readonly disabled?: boolean;
  readonly validation?: Readonly<Record<string, ValidationResult>>;
  readonly applyStatus?: string;
  /** A sentence under the heading for a save that the environment still overrides; it wraps, unlike the pill. */
  readonly notice?: string;
  readonly unsavedKeys?: readonly string[];
  readonly onStage?: (state: StagedSettings) => void;
  readonly onSecretAction?: (key: string, action: "set" | "unset") => void;
  readonly onPreview?: (key: string, preview: PreviewResult) => void;
  readonly onCommit?: () => void;
  readonly onCancel?: () => void;
  /** List editors this section draws inside its card, after the rows and above Save and Cancel. */
  readonly listControls?: ReactNode;
};

export function SettingsSection({
  descriptor,
  snapshot,
  staged = { snapshot, edits: {} },
  disabled = false,
  validation = {},
  applyStatus,
  notice,
  unsavedKeys = [],
  onStage,
  onSecretAction,
  onPreview,
  onCommit,
  onCancel,
  listControls,
}: SettingsSectionProps) {
  // The latest check of each control in this section, so errors show (and block Save) even when
  // the caller doesn't track `onPreview`; the caller's `validation` fills in the rest.
  const [checks, setChecks] = useState<Readonly<Record<string, ValidationResult>>>({});
  // Bumped by Cancel so structured editors drop rows the user was still typing.
  const [resetToken, setResetToken] = useState(0);
  const check = (key: string, result: ValidationResult) => {
    setChecks((current) => {
      if (result.valid) {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      return { ...current, [key]: result };
    });
  };
  const shown = (key: string): ValidationResult | undefined => checks[key] ?? validation[key];
  const hasError = descriptor.controls.some((control) => shown(control.key)?.valid === false);
  return (
    <Section
      heading={descriptor.title}
      headingId={`${descriptor.id}-title`}
      actions={
        applyStatus ? (
          <span className="bg-muted text-muted-foreground rounded-full px-2.5 py-1 text-xs font-medium">
            {applyStatus}
          </span>
        ) : null
      }
    >
      {notice ? <p className="text-foreground mb-3 text-sm">{notice}</p> : null}
      <div className="divide-border/60 divide-y">
        {descriptor.controls.map((control) => (
          <SettingControlRow
            key={control.key}
            control={control}
            entry={effectiveEntry(snapshot, control.key)}
            value={staged.edits[control.key]}
            validation={shown(control.key)}
            unsaved={unsavedKeys.includes(control.key)}
            disabled={disabled}
            resetToken={resetToken}
            onStage={(value) => {
              const result = stage(descriptor, staged, control.key, value);
              if (result.ok) {
                check(control.key, { valid: true });
                onStage?.(result.state);
                onPreview?.(control.key, {
                  ok: true,
                  patch: control.preview?.(value, snapshot) ?? null,
                });
              } else {
                check(control.key, result.validation);
                onPreview?.(control.key, { ok: false, validation: result.validation });
              }
            }}
            onInvalid={(result) => {
              check(control.key, result);
              onPreview?.(control.key, { ok: false, validation: result });
            }}
            onSecretAction={onSecretAction}
          />
        ))}
        {listControls}
      </div>
      <div className="mt-5">
        <Toolbar ariaLabel="Settings actions" alignment="end">
          {onCancel ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setChecks({});
                setResetToken((token) => token + 1);
                onCancel();
              }}
              disabled={disabled}
            >
              Cancel
            </Button>
          ) : null}
          {onCommit ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCommit}
              disabled={disabled || hasError || Object.keys(staged.edits).length === 0}
            >
              Save changes
            </Button>
          ) : null}
        </Toolbar>
      </div>
    </Section>
  );
}

/**
 * The line a save leaves when omp did not write some of its settings: which ones, and why. Both
 * settings screens show it. It has no Retry: "Save changes" writes the same edits again.
 */
export function UnsavedSettingsNotice({
  labels,
  reason,
}: {
  readonly labels: readonly string[];
  readonly reason: string;
}) {
  if (labels.length === 0) return null;
  return (
    <InlineError heading={`Not saved: ${labels.join(", ")}.`} message={reason} variant="boxed" />
  );
}

type SettingControlRowProps = {
  readonly control: SettingControl;
  readonly entry?: ConfigEntry;
  readonly value?: SettingValue;
  readonly validation?: ValidationResult;
  readonly disabled: boolean;
  readonly unsaved: boolean;
  readonly resetToken: number;
  readonly onStage: (value: SettingValue) => void;
  readonly onInvalid: (validation: ValidationResult & { readonly valid: false }) => void;
  readonly onSecretAction?: (key: string, action: "set" | "unset") => void;
};

function SettingControlRow({
  control,
  entry,
  value,
  validation,
  disabled,
  unsaved,
  resetToken,
  onStage,
  onInvalid,
  onSecretAction,
}: SettingControlRowProps) {
  const secret = entry ? secretSummary(entry) : null;
  const effectiveValue =
    value?.secret === false ? value.value : entry && !entry.secret ? entry.value : undefined;
  const committedValue = entry && !entry.secret ? entry.value : undefined;
  const provenance = entry ? provenanceLabel(entry) : "not configured";
  // A value the server hid (a credential in its URL) reads as a sentence: the input would be an empty box.
  const hiddenValue =
    entry?.secret === true && !control.secret
      ? `${settingSourceLabel(entry.source)}; the value is hidden.`
      : undefined;
  const setSecret = () => onSecretAction?.(control.key, "set");
  const unsetSecret = () => onSecretAction?.(control.key, "unset");
  const secretActionLabel = secret?.isSet ? "Replace…" : "Set…";
  const invalid = validation !== undefined && !validation.valid;
  // What the person typed, kept so that a value the setting does not accept stays in the field under its error
  // message: such a value is never staged, so the field would otherwise jump back to the last good value. Cancel
  // bumps the token, which drops it.
  const [typed, setTyped] = useState<{ readonly token: number; readonly text: string } | undefined>(
    undefined,
  );
  const fieldText =
    invalid && typed !== undefined && typed.token === resetToken
      ? typed.text
      : effectiveValue === undefined
        ? ""
        : String(effectiveValue);

  return (
    <SettingRow
      title={control.label}
      description={control.description}
      detail={<span data-testid={`${control.key}-provenance`}>Source: {provenance}</span>}
      layout="stacked"
      notice={unsaved ? "Not saved" : undefined}
    >
      {control.secret ? (
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="bg-muted text-muted-foreground rounded-md px-2.5 py-1.5 text-sm"
            data-testid={`${control.key}-secret-status`}
          >
            {secret?.isSet ? "Set" : "Not set"}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={setSecret} disabled={disabled}>
            {secretActionLabel}
          </Button>
          {secret?.isSet ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={unsetSecret}
              disabled={disabled}
            >
              Unset
            </Button>
          ) : null}
        </div>
      ) : control.readOnly ? (
        <ReadOnlyValue control={control} value={effectiveValue} />
      ) : isStructuredControl(control) ? (
        <StructuredEditor
          committed={committedValue}
          control={control}
          disabled={disabled}
          resetToken={resetToken}
          value={effectiveValue}
          onInvalid={onInvalid}
          onValue={(next) => onStage({ secret: false, value: next })}
        />
      ) : hiddenValue !== undefined ? (
        <p className="text-muted-foreground text-sm" data-testid={`${control.key}-hidden`}>
          {hiddenValue}
        </p>
      ) : (
        <ControlInput
          control={control}
          value={fieldText}
          disabled={disabled}
          onValue={(next) => {
            setTyped({ token: resetToken, text: next });
            onStage({ secret: false, value: parseControlValue(control, next) });
          }}
        />
      )}
      {validation && !validation.valid ? (
        <InlineError message={validation.message} variant="message" />
      ) : null}
    </SettingRow>
  );
}

function ControlInput({
  control,
  value,
  disabled,
  onValue,
}: {
  readonly control: ScalarSettingControl;
  readonly value: string;
  readonly disabled: boolean;
  readonly onValue: (value: string) => void;
}) {
  if (control.kind === "boolean") {
    return (
      <label className="border-input bg-background has-focus-visible:ring-ring/50 flex min-h-8 cursor-pointer items-center gap-2 rounded-lg border px-2.5 text-sm has-focus-visible:ring-2">
        <input
          aria-label={control.label}
          type="checkbox"
          checked={value === "true"}
          onChange={(event) => onValue(String(event.target.checked))}
          disabled={disabled}
        />
        <span>{value === "true" ? "On" : "Off"}</span>
      </label>
    );
  }
  if (control.kind === "enum" && control.options) {
    return (
      <select
        aria-label={control.label}
        className="border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-2"
        style={{ color: "var(--foreground)", WebkitTextFillColor: "var(--foreground)" }}
        value={value}
        onChange={(event) => onValue(event.target.value)}
        disabled={disabled}
      >
        {control.options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  if (control.kind === "multiline") {
    return (
      <Textarea
        aria-label={control.label}
        className="text-foreground"
        style={{ color: "var(--foreground)", WebkitTextFillColor: "var(--foreground)" }}
        value={value}
        onChange={(event) => onValue(event.target.value)}
        disabled={disabled}
      />
    );
  }
  return (
    <Input
      aria-label={control.label}
      className="text-foreground"
      style={{ color: "var(--foreground)", WebkitTextFillColor: "var(--foreground)" }}
      type={control.kind === "number" || control.kind === "duration" ? "number" : "text"}
      value={value}
      onChange={(event) => onValue(event.target.value)}
      disabled={disabled}
    />
  );
}

function parseControlValue(
  control: ScalarSettingControl,
  value: string,
): string | number | boolean | readonly string[] {
  if (control.kind === "boolean") return value === "true";
  if (control.kind === "number" || control.kind === "duration") {
    // An emptied field is not 0: Number("") is 0, so it would be staged and saved without a word. It stays text, and
    // the control's own check says what it needs.
    if (value.trim() === "") return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (control.kind === "list")
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  return value;
}
