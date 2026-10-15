import type { JsonValue } from "@omp-app/contracts";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { checkboxRowLook, SELECT_DISABLED_LOOK } from "./control-look";
import {
  emptyStructuredDraft,
  type MapSettingControl,
  type RowsSettingControl,
  type SettingControl,
  type SettingField,
  type StructuredDraftRow,
  structuredDrafts,
  structuredValue,
  type ValidationResult,
} from "./grammar";

type StructuredControl = MapSettingControl | RowsSettingControl;

type DraftRow = { readonly id: number; readonly values: StructuredDraftRow };

let nextRowId = 0;

function withIds(rows: readonly StructuredDraftRow[]): readonly DraftRow[] {
  return rows.map((values) => ({ id: nextRowId++, values }));
}

/** The columns of a structured control: a map's name and value, or a rows control's fields. */
function columnsOf(control: StructuredControl): readonly [string, SettingField][] {
  if (control.kind === "rows") return Object.entries(control.fields);
  return [
    [
      "key",
      {
        label: control.keyLabel,
        kind: "text",
        ...(control.keyPlaceholder ? { placeholder: control.keyPlaceholder } : {}),
      },
    ],
    ["value", control.value],
  ];
}

export function isStructuredControl(control: SettingControl): control is StructuredControl {
  return control.kind === "map" || control.kind === "rows";
}

// The kit's scalar inputs pin the text color the same way (native selects in dark mode).
const FIELD_TEXT_STYLE = { color: "var(--foreground)", WebkitTextFillColor: "var(--foreground)" };

function FieldInput({
  field,
  value,
  label,
  disabled,
  onChange,
}: {
  readonly field: SettingField;
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  if (field.kind === "boolean") {
    return (
      <label className={checkboxRowLook(disabled)}>
        <input
          aria-label={label}
          checked={value === "true"}
          disabled={disabled}
          type="checkbox"
          onChange={(event) => onChange(String(event.target.checked))}
        />
        <span>{value === "true" ? "On" : "Off"}</span>
      </label>
    );
  }
  if (field.kind === "enum") {
    return (
      <select
        aria-label={label}
        className={cn(
          "border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-36 shrink-0 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-2",
          SELECT_DISABLED_LOOK,
        )}
        disabled={disabled}
        style={FIELD_TEXT_STYLE}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {(field.options ?? []).map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <Input
      aria-label={label}
      className={
        field.kind === "number" ? "text-foreground w-28 shrink-0" : "text-foreground min-w-0 flex-1"
      }
      disabled={disabled}
      placeholder={field.placeholder}
      style={FIELD_TEXT_STYLE}
      type={field.kind === "number" ? "number" : "text"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * Edits a map or rows setting as rows of inputs. It keeps the rows the user is typing (which may be
 * incomplete); every change reports either the complete value (`onValue`) or the first problem
 * (`onInvalid`). The rows reset to the stored value when it changes or the section is cancelled.
 */
export function StructuredEditor({
  control,
  value,
  committed,
  resetToken,
  disabled,
  onValue,
  onInvalid,
}: {
  readonly control: StructuredControl;
  /** The value being edited: the staged edit, else the stored value. */
  readonly value: JsonValue | undefined;
  /** The stored value; when it changes (saved, or changed elsewhere) the rows follow it. */
  readonly committed: JsonValue | undefined;
  /** Changes when the section is cancelled. */
  readonly resetToken: number;
  readonly disabled: boolean;
  readonly onValue: (value: JsonValue) => void;
  readonly onInvalid: (validation: ValidationResult & { readonly valid: false }) => void;
}) {
  const [rows, setRows] = useState<readonly DraftRow[]>(() =>
    withIds(structuredDrafts(control, value)),
  );
  const committedJson = JSON.stringify(committed ?? null);
  const synced = useRef({ committedJson, resetToken });
  useEffect(() => {
    const previous = synced.current;
    if (previous.committedJson === committedJson && previous.resetToken === resetToken) {
      return;
    }
    synced.current = { committedJson, resetToken };
    // Cancel drops the staged edit, so the rows go back to the stored value. A stored value that changed
    // elsewhere keeps this section's staged edit: after "Keep mine" the rows show what Save would write.
    const shown = previous.resetToken === resetToken ? value : committed;
    setRows(withIds(structuredDrafts(control, shown)));
  }, [committed, committedJson, control, resetToken, value]);

  const update = (next: readonly DraftRow[]) => {
    setRows(next);
    const result = structuredValue(
      control,
      next.map((row) => row.values),
    );
    if (result.ok) onValue(result.value);
    else onInvalid(result.validation);
  };
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    const row = rows[index];
    const other = rows[target];
    if (!row || !other) return;
    const next = [...rows];
    next[index] = other;
    next[target] = row;
    update(next);
  };
  const columns = columnsOf(control);
  const ordered = control.kind === "rows" && control.ordered;
  // Keyboard focus after an edit: the new row's first field after Add, the Add button after Remove.
  const listRef = useRef<HTMLFieldSetElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const focusAfterEdit = useRef<number | "add" | undefined>(undefined);
  useEffect(() => {
    const target = focusAfterEdit.current;
    if (target === undefined) return;
    focusAfterEdit.current = undefined;
    const element =
      target === "add"
        ? addRef.current
        : listRef.current?.querySelector<HTMLElement>(
            `[data-row-id="${target}"] input, [data-row-id="${target}"] select`,
          );
    element?.focus();
  });

  return (
    <fieldset
      aria-label={control.label}
      className="min-w-0 space-y-2"
      data-slot="s1-structured-control"
      ref={listRef}
    >
      {rows.map((row, index) => {
        const position = index + 1;
        const name = control.kind === "map" ? (row.values.key ?? "").trim() : "";
        return (
          <div
            className="flex min-w-0 flex-wrap items-center gap-2"
            data-row-id={row.id}
            key={row.id}
          >
            {columns.map(([field, definition]) => (
              <FieldInput
                disabled={disabled}
                field={definition}
                key={field}
                label={`${definition.label} ${position}`}
                value={row.values[field] ?? ""}
                onChange={(text) =>
                  update(
                    rows.map((candidate) =>
                      candidate.id === row.id
                        ? { ...candidate, values: { ...candidate.values, [field]: text } }
                        : candidate,
                    ),
                  )
                }
              />
            ))}
            {ordered ? (
              <>
                <Button
                  aria-label={`Move row ${position} up`}
                  disabled={disabled || index === 0}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                  onClick={() => move(index, -1)}
                >
                  <ChevronUpIcon aria-hidden="true" />
                </Button>
                <Button
                  aria-label={`Move row ${position} down`}
                  disabled={disabled || index === rows.length - 1}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                  onClick={() => move(index, 1)}
                >
                  <ChevronDownIcon aria-hidden="true" />
                </Button>
              </>
            ) : null}
            <Button
              aria-label={`Remove ${name || `row ${position}`}`}
              disabled={disabled}
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                focusAfterEdit.current = "add";
                update(rows.filter((candidate) => candidate.id !== row.id));
              }}
            >
              Remove
            </Button>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={disabled}
          ref={addRef}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => {
            const id = nextRowId++;
            focusAfterEdit.current = id;
            update([...rows, { id, values: emptyStructuredDraft(control) }]);
          }}
        >
          {control.addLabel}
        </Button>
        {rows.length === 0 ? (
          <span className="text-muted-foreground text-xs">{control.emptyLabel}</span>
        ) : null}
      </div>
    </fieldset>
  );
}

function scalarText(value: JsonValue | undefined, options?: SettingField["options"]): string {
  if (value === undefined || value === null) return "Not set";
  const option = options?.find((candidate) => String(candidate.value) === String(value));
  if (option) return option.label;
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value)) {
    return value.length === 0 ? "None" : value.map((item) => scalarText(item)).join(", ");
  }
  return typeof value === "object" ? "Set" : String(value);
}

function draftText(field: SettingField, draft: string | undefined): string {
  if (field.kind === "boolean") return draft === "true" ? "On" : "Off";
  if (field.kind === "enum") return scalarText(draft, field.options);
  if (field.kind === "list") return draft && draft.trim().length > 0 ? draft : "Not set";
  return draft && draft.length > 0 ? draft : "Not set";
}

/** One structured row as a line of text: "openai: 4", or "Command pattern: git * · Approval: Allow". */
function rowText(control: StructuredControl, row: StructuredDraftRow): string {
  if (control.kind === "map") return `${row.key ?? ""}: ${draftText(control.value, row.value)}`;
  return Object.entries(control.fields)
    .map(([field, definition]) => `${definition.label}: ${draftText(definition, row[field])}`)
    .join(" · ");
}

/** A read-only setting: its value as text, and where to change it. */
export function ReadOnlyValue({
  control,
  value,
}: {
  readonly control: SettingControl;
  readonly value: JsonValue | undefined;
}) {
  let body: ReactNode;
  if (isStructuredControl(control)) {
    // Identical rows (allowed in a rows setting) get "(2)", "(3)" keys so React keeps them apart.
    const seen = new Map<string, number>();
    const lines = structuredDrafts(control, value).map((row) => {
      const text = rowText(control, row);
      const count = (seen.get(text) ?? 0) + 1;
      seen.set(text, count);
      return { key: count === 1 ? text : `${text} (${count})`, text };
    });
    body =
      lines.length === 0 ? (
        <p className="text-muted-foreground text-sm">{control.emptyLabel}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {lines.map((line) => (
            <li className="min-w-0 break-words" key={line.key}>
              {line.text}
            </li>
          ))}
        </ul>
      );
  } else {
    body = <p className="text-sm">{scalarText(value, control.options)}</p>;
  }
  return (
    <div className="min-w-0 space-y-2" data-slot="s1-read-only">
      {body}
      {control.readOnly ? (
        <p className="text-muted-foreground text-xs">{control.readOnly.reason}</p>
      ) : null}
    </div>
  );
}
