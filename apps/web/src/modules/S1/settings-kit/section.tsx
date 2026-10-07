import type { ConfigEntry } from "@omp-app/contracts";
import { useState } from "react";
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
import { effectiveEntry, provenanceLabel, secretSummary, stage } from "./grammar";
import { isStructuredControl, ReadOnlyValue, StructuredEditor } from "./structured";

export type SettingsSectionProps = {
  readonly descriptor: SettingsSectionDescriptor;
  readonly snapshot: ConfigSnapshot;
  readonly staged?: StagedSettings;
  readonly disabled?: boolean;
  readonly validation?: Readonly<Record<string, ValidationResult>>;
  readonly applyStatus?: string;
  readonly onStage?: (state: StagedSettings) => void;
  readonly onSecretAction?: (key: string, action: "set" | "unset") => void;
  readonly onPreview?: (key: string, preview: PreviewResult) => void;
  readonly onCommit?: () => void;
  readonly onCancel?: () => void;
};

export function SettingsSection({
  descriptor,
  snapshot,
  staged = { snapshot, edits: {} },
  disabled = false,
  validation = {},
  applyStatus,
  onStage,
  onSecretAction,
  onPreview,
  onCommit,
  onCancel,
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
      <div className="divide-border/60 divide-y">
        {descriptor.controls.map((control) => (
          <SettingControlRow
            key={control.key}
            control={control}
            entry={effectiveEntry(snapshot, control.key)}
            value={staged.edits[control.key]}
            validation={shown(control.key)}
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

type SettingControlRowProps = {
  readonly control: SettingControl;
  readonly entry?: ConfigEntry;
  readonly value?: SettingValue;
  readonly validation?: ValidationResult;
  readonly disabled: boolean;
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
  const setSecret = () => onSecretAction?.(control.key, "set");
  const unsetSecret = () => onSecretAction?.(control.key, "unset");
  const secretActionLabel = secret?.isSet ? "Replace…" : "Set…";

  return (
    <SettingRow
      title={control.label}
      description={control.description}
      detail={<span data-testid={`${control.key}-provenance`}>Source: {provenance}</span>}
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
      ) : (
        <ControlInput
          control={control}
          value={effectiveValue === undefined ? "" : String(effectiveValue)}
          disabled={disabled}
          onValue={(next) => onStage({ secret: false, value: parseControlValue(control, next) })}
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
