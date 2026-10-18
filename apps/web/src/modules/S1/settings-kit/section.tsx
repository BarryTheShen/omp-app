import type { ConfigEntry } from "@omp-app/contracts";
import { cn } from "cn";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { InlineError, Section, SettingRow, Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { checkboxRowLook, SELECT_DISABLED_LOOK } from "./control-look";
import type {
  ApplyBoundary,
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
  applyStatusLabel,
  effectiveEntry,
  provenanceLabel,
  secretSummary,
  settingSourceLabel,
  stage,
  validate,
} from "./grammar";
import { isStructuredControl, ReadOnlyValue, StructuredEditor } from "./structured";

const APPLY_BOUNDARY_REPORT: Record<
  ApplyBoundary,
  { readonly label: string; readonly detail: string }
> = {
  live: {
    label: "Live",
    detail: "New operations use the saved setting; work already underway is not interrupted.",
  },
  session: {
    label: applyStatusLabel("session-only"),
    detail:
      "New operations in this session use the saved setting; existing processes keep running.",
  },
  reload: {
    label: applyStatusLabel("reload-required"),
    detail: "Reload omp to use this setting. Existing work continues unchanged.",
  },
  restart: {
    label: applyStatusLabel("restart-required"),
    detail: "Restart omp to use this setting; saving does not stop it.",
  },
  unsupported: {
    label: applyStatusLabel("unsupported"),
    detail: "omp cannot apply this setting yet.",
  },
};

function SettingsApplyReport({ descriptor }: { readonly descriptor: SettingsSectionDescriptor }) {
  if (!descriptor.applyReport) return null;
  const grouped = new Map<ApplyBoundary, string[]>();
  for (const control of descriptor.controls) {
    const labels = grouped.get(control.apply) ?? [];
    labels.push(control.label);
    grouped.set(control.apply, labels);
  }
  return (
    <fieldset aria-label="When settings take effect" className="mt-5 text-sm">
      <legend className="font-medium text-foreground">When changes take effect</legend>
      <ul className="mt-2 flex flex-col gap-2 text-muted-foreground">
        {[...grouped].map(([boundary, labels]) => {
          const report = APPLY_BOUNDARY_REPORT[boundary];
          return (
            <li key={boundary}>
              <strong className="font-medium text-foreground">{report.label}:</strong>{" "}
              {labels.join(", ")}. {report.detail}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-muted-foreground">{descriptor.applyReport.note}</p>
    </fieldset>
  );
}

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
            snapshot={snapshot}
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
      <SettingsApplyReport descriptor={descriptor} />
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
  readonly snapshot: ConfigSnapshot;
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
  snapshot,
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
  const firstEnumOption = control.kind === "enum" ? control.options?.[0] : undefined;
  const enumMatchesOption =
    control.kind === "enum" &&
    effectiveValue !== undefined &&
    (control.options ?? []).some((option) => String(option.value) === String(effectiveValue));
  const unrecognized =
    !control.secret &&
    !control.readOnly &&
    effectiveValue !== undefined &&
    ((control.kind === "boolean" && typeof effectiveValue !== "boolean") ||
      (control.kind === "enum" &&
        firstEnumOption !== undefined &&
        !enumMatchesOption &&
        !validate(control, { secret: false, value: effectiveValue }, snapshot).valid));
  const resetLabel =
    control.kind === "boolean" ? "Turn off" : `Use ${firstEnumOption?.label ?? "first option"}`;
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const returnFocusAfterReset = useRef(false);
  const setInputRef = useCallback((input: HTMLInputElement | HTMLSelectElement | null) => {
    inputRef.current = input;
    if (input && returnFocusAfterReset.current) {
      returnFocusAfterReset.current = false;
      input.focus();
    }
  }, []);

  // What the person typed, kept so that a value the setting does not accept stays in the field under its error
  // message: such a value is never staged, so the field would otherwise jump back to the last good value. Cancel
  // bumps the token, which drops it.
  const [typed, setTyped] = useState<{ readonly token: number; readonly text: string } | undefined>(
    undefined,
  );
  const typedText = typed !== undefined && typed.token === resetToken ? typed.text : undefined;
  // A list is drawn from its array, which has no comma after the last item: a comma just typed would vanish, so a
  // second item could only be pasted. The typed text stays while it still says the list the setting holds.
  const keepsTypedList =
    control.kind === "list" &&
    typedText !== undefined &&
    JSON.stringify(parseControlValue(control, typedText)) === JSON.stringify(effectiveValue);
  const fieldText =
    typedText !== undefined && (invalid || keepsTypedList)
      ? typedText
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
      {unrecognized ? (
        <InlineError
          actions={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                returnFocusAfterReset.current = true;
                if (control.kind === "boolean") {
                  onStage({ secret: false, value: false });
                } else if (firstEnumOption) {
                  onStage({ secret: false, value: firstEnumOption.value });
                }
              }}
              disabled={disabled}
            >
              {resetLabel}
            </Button>
          }
          message="This setting has an unrecognized value."
          variant="compact"
        />
      ) : control.secret ? (
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
        <HiddenValue
          key={resetToken}
          control={control}
          sentence={hiddenValue}
          canChange={entry?.source !== "env"}
          staged={value}
          snapshot={snapshot}
          disabled={disabled}
          onStage={onStage}
        />
      ) : (
        <ControlInput
          control={control}
          value={fieldText}
          setFocusRef={setInputRef}
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

/**
 * A saved value the server hid, such as a URL whose query carries a credential. Replace takes a new address as a
 * secret edit, so the typed text is not shown back, and Unset removes the saved one. A value set in the environment
 * cannot be changed here, so it only reads as a sentence.
 */
function HiddenValue({
  control,
  sentence,
  canChange,
  staged,
  snapshot,
  disabled,
  onStage,
}: {
  readonly control: SettingControl;
  readonly sentence: string;
  readonly canChange: boolean;
  readonly staged: SettingValue | undefined;
  readonly snapshot: ConfigSnapshot;
  readonly disabled: boolean;
  readonly onStage: (value: SettingValue) => void;
}) {
  const fieldId = useId();
  const fieldRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  // Set when the field closes (Cancel, or an address staged), so Replace… takes the focus back. Discarding the
  // section's changes remounts this field (SettingControlRow keys it by the reset token), so no focus moves.
  const restoreFocus = useRef(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (editing) {
      fieldRef.current?.focus();
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      replaceRef.current?.focus();
    }
  }, [editing]);
  const pending =
    staged?.secret !== true
      ? undefined
      : staged.action === "unset"
        ? "Will be unset when you save."
        : "A new address is ready to save.";
  const closeEditor = () => {
    restoreFocus.current = true;
    setEditing(false);
    setDraft("");
    setError(undefined);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const checked = validate(control, { secret: false, value: draft }, snapshot);
    if (!checked.valid) {
      setError(checked.message);
      return;
    }
    closeEditor();
    onStage({ secret: true, action: "set", value: draft });
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-sm" data-testid={`${control.key}-hidden`}>
        {sentence}
      </p>
      {pending ? <p className="text-foreground text-sm">{pending}</p> : null}
      {canChange && editing ? (
        <form className="flex flex-col gap-2" onSubmit={submit}>
          <label className="text-sm font-medium" htmlFor={fieldId}>
            New address
          </label>
          <Input
            id={fieldId}
            ref={fieldRef}
            type="password"
            autoComplete="off"
            value={draft}
            disabled={disabled}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(undefined);
            }}
          />
          {error ? <InlineError message={error} variant="message" /> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={disabled}>
              Use this address
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={closeEditor}
              disabled={disabled}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : canChange ? (
        <div className="flex flex-wrap gap-2">
          <Button
            ref={replaceRef}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setEditing(true)}
            disabled={disabled}
          >
            Replace…
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onStage({ secret: true, action: "unset" })}
            disabled={disabled}
          >
            Unset
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ControlInput({
  control,
  value,
  disabled,
  onValue,
  setFocusRef,
}: {
  readonly control: ScalarSettingControl;
  readonly value: string;
  readonly disabled: boolean;
  readonly onValue: (value: string) => void;
  readonly setFocusRef: (element: HTMLInputElement | HTMLSelectElement | null) => void;
}) {
  if (control.kind === "boolean") {
    return (
      <label className={checkboxRowLook(disabled)}>
        <input
          ref={setFocusRef}
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
        ref={setFocusRef}
        aria-label={control.label}
        className={cn(
          "border-input bg-background text-foreground transition-colors focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-2",
          SELECT_DISABLED_LOOK,
        )}
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
