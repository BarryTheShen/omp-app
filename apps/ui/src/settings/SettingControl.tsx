import type { ConfigEntry, ConfigWriteValue, JsonValue } from "@omp-app/contracts";
import { ArrowDown, ArrowUp } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { SettingDef } from "./data";

/** Saves a value, or `"unset"` takes the setting out of the file (omp's default again). */
type Write = (value: ConfigWriteValue | "unset") => void;

interface Choice {
  readonly value: string;
  readonly label: string;
}

/** What a setting picks from: omp's list for it, an enum's values, or the only entries a list takes. */
function choicesOf(def: SettingDef): readonly Choice[] {
  return def.choices ?? (def.values ?? def.items ?? []).map((value) => ({ value, label: value }));
}

/** A control that takes the row's width, under its words (lists and JSON). */
export function wide(def: SettingDef): boolean {
  return !def.secret && (def.type === "array" || def.type === "record");
}

/** Esc in a field puts back the value in force, and keeps the settings open while it does. */
function revertOnEscape(event: KeyboardEvent, changed: boolean, revert: () => void): void {
  if (event.key !== "Escape" || !changed) return;
  event.preventDefault();
  event.stopPropagation();
  revert();
}

/** The control for one setting, by omp's type for it. `value` is the value in force. */
export function SettingControl({
  def,
  entry,
  value,
  disabled,
  write,
}: {
  readonly def: SettingDef;
  readonly entry: ConfigEntry | undefined;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly write: Write;
}): ReactNode {
  if (def.secret) {
    return (
      <SecretControl
        def={def}
        isSet={entry?.secret === true && entry.isSet}
        disabled={disabled}
        write={write}
      />
    );
  }
  const props = { def, value, disabled, write };
  switch (def.type) {
    case "boolean":
      return (
        <Switch
          aria-label={def.label}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => write({ secret: false, value: checked })}
        />
      );
    case "enum":
      return <ChoiceControl {...props} />;
    case "number":
    case "string":
      return choicesOf(def).length > 0 ? (
        <ChoiceControl {...props} />
      ) : (
        <TextControl {...props} numeric={def.type === "number"} />
      );
    case "array":
      if (def.json === true) return <JsonControl {...props} />;
      return choicesOf(def).length > 0 ? <MemberControl {...props} /> : <LinesControl {...props} />;
    default:
      return <JsonControl {...props} />;
  }
}

interface ControlProps {
  readonly def: SettingDef;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly write: Write;
}

/** One of a few short choices as a segmented switch, more of them in a menu. */
function ChoiceControl({ def, value, disabled, write }: ControlProps): ReactNode {
  const choices = choicesOf(def);
  const current = value === undefined || value === null ? "" : String(value);
  // A number's choices carry the number as text.
  const pick = (next: string): void => {
    if (next !== current)
      write({ secret: false, value: def.type === "number" ? Number(next) : next });
  };
  if (choices.length <= 3 && choices.every((choice) => choice.label.length <= 14)) {
    return (
      <ToggleGroup
        aria-label={def.label}
        size="sm"
        spacing={0.5}
        disabled={disabled}
        className="rounded-lg border border-l2 p-0.5"
        value={[current]}
        onValueChange={(next: string[]) => {
          if (next[0] !== undefined) pick(next[0]);
        }}
      >
        {choices.map((choice) => (
          <ToggleGroupItem
            key={choice.value}
            value={choice.value}
            className="h-6 px-2 text-xs text-t3 hover:text-t1 aria-pressed:bg-l2 aria-pressed:text-t1"
          >
            {choice.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    );
  }
  return (
    <Select
      items={choices}
      value={current}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") pick(next);
      }}
    >
      <SelectTrigger
        aria-label={def.label}
        size="sm"
        className="min-w-36 justify-between dark:bg-transparent"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {choices.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Text or a number, saved on Enter or on leaving the field; empty takes omp's default again. */
function TextControl({
  def,
  value,
  disabled,
  write,
  numeric,
}: ControlProps & { readonly numeric: boolean }): ReactNode {
  const inForce = value === undefined || value === null ? "" : String(value);
  const [draft, setDraft] = useState(inForce);
  const [wrong, setWrong] = useState<string | null>(null);
  useEffect(() => {
    setDraft(inForce);
    setWrong(null);
  }, [inForce]);
  const commit = (): void => {
    if (draft === inForce) return;
    if (draft.trim() === "") {
      write("unset");
      return;
    }
    if (!numeric) {
      write({ secret: false, value: draft });
      return;
    }
    const number = Number(draft.trim());
    if (!Number.isFinite(number)) {
      setWrong("Type a number.");
      return;
    }
    write({ secret: false, value: number });
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <Input
        aria-label={def.label}
        value={draft}
        disabled={disabled}
        inputMode={numeric ? "decimal" : undefined}
        aria-invalid={wrong !== null}
        placeholder={def.default === undefined ? "not set" : String(def.default)}
        // Over the sheet's own background: the input's tint left dark mode's placeholder too faint.
        className={`dark:bg-transparent ${numeric ? "h-8 w-28 text-right" : "h-8 w-64"}`}
        onChange={(event) => {
          setDraft(event.target.value);
          setWrong(null);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            return;
          }
          revertOnEscape(event, draft !== inForce, () => {
            setDraft(inForce);
            setWrong(null);
          });
        }}
      />
      {wrong !== null && (
        <p role="alert" className="text-xs text-bad-ink">
          {wrong}
        </p>
      )}
    </div>
  );
}

/** A secret is never shown: it is set or not, replaced, or cleared by the row's Reset. */
function SecretControl({
  def,
  isSet,
  disabled,
  write,
}: {
  readonly def: SettingDef;
  readonly isSet: boolean;
  readonly disabled: boolean;
  readonly write: Write;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const stop = (): void => {
    setEditing(false);
    setDraft("");
  };
  if (editing) {
    return (
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft === "") return;
          write({ secret: true, action: "set", value: draft });
          stop();
        }}
      >
        <Input
          type="password"
          autoComplete="off"
          aria-label={def.label}
          autoFocus
          value={draft}
          className="h-8 w-56 dark:bg-transparent"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => revertOnEscape(event, true, stop)}
        />
        <Button type="submit" size="sm" disabled={draft === ""}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={stop}>
          Cancel
        </Button>
      </form>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-t3">{isSet ? "Set" : "Not set"}</span>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        aria-label={`${isSet ? "Replace" : "Set"} ${def.label}`}
        onClick={() => setEditing(true)}
      >
        {isSet ? "Replace" : "Set"}
      </Button>
    </div>
  );
}

const moved = (list: readonly string[], index: number, by: -1 | 1): string[] => {
  const next = [...list];
  const [item] = next.splice(index, 1);
  if (item !== undefined) next.splice(index + by, 0, item);
  return next;
};

/** A list of known entries: each one on or off; where the order matters, the chosen ones come first and move. */
function MemberControl({ def, value, disabled, write }: ControlProps): ReactNode {
  const choices = choicesOf(def);
  const members = Array.isArray(value) ? value.map(String) : [];
  const set = (next: string[]): void => write({ secret: false, value: next });
  const ordered = def.ordered === true;
  const rows: readonly Choice[] = ordered
    ? [
        ...members.map(
          (member) =>
            choices.find((choice) => choice.value === member) ?? { value: member, label: member },
        ),
        ...choices.filter((choice) => !members.includes(choice.value)),
      ]
    : choices;
  return (
    <ul aria-label={def.label} className="grid gap-1 sm:grid-cols-2">
      {rows.map((choice) => {
        const at = members.indexOf(choice.value);
        const on = at >= 0;
        return (
          <li key={choice.value} className="flex min-w-0 items-center gap-2 text-sm">
            <Checkbox
              aria-label={choice.label}
              checked={on}
              disabled={disabled}
              onCheckedChange={(checked) =>
                set(
                  checked
                    ? [...members, choice.value]
                    : members.filter((member) => member !== choice.value),
                )
              }
            />
            <span className={`min-w-0 truncate ${on ? "text-t1" : "text-t3"}`}>{choice.label}</span>
            {ordered && on && (
              <span className="ml-auto flex shrink-0">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Move ${choice.label} up`}
                  disabled={disabled || at === 0}
                  onClick={() => set(moved(members, at, -1))}
                >
                  <ArrowUp />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Move ${choice.label} down`}
                  disabled={disabled || at === members.length - 1}
                  onClick={() => set(moved(members, at, 1))}
                >
                  <ArrowDown />
                </Button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A list of free entries, one per line, saved on leaving the field. */
function LinesControl({ def, value, disabled, write }: ControlProps): ReactNode {
  const inForce = Array.isArray(value) ? value.map(String).join("\n") : "";
  const [draft, setDraft] = useState(inForce);
  useEffect(() => setDraft(inForce), [inForce]);
  return (
    <Textarea
      aria-label={def.label}
      value={draft}
      disabled={disabled}
      spellCheck={false}
      placeholder="One per line"
      rows={Math.min(8, Math.max(2, draft.split("\n").length))}
      className="font-mono text-xs dark:bg-transparent"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const lines = draft
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "");
        if (lines.join("\n") !== inForce) write({ secret: false, value: lines });
      }}
      onKeyDown={(event) => revertOnEscape(event, draft !== inForce, () => setDraft(inForce))}
    />
  );
}

/** A map, or a list omp edits as JSON, saved on leaving the field when it is the right kind of JSON. */
function JsonControl({ def, value, disabled, write }: ControlProps): ReactNode {
  const inForce = value === undefined || value === null ? "" : JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(inForce);
  const [wrong, setWrong] = useState<string | null>(null);
  useEffect(() => {
    setDraft(inForce);
    setWrong(null);
  }, [inForce]);
  const list = def.type === "array";
  const commit = (): void => {
    if (draft.trim() === inForce.trim()) return;
    if (draft.trim() === "") {
      write("unset");
      return;
    }
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(draft) as JsonValue;
    } catch {
      setWrong("This is not valid JSON.");
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) !== list) {
      setWrong(
        list ? 'Type a JSON list, like ["a", "b"].' : 'Type a JSON object, like {"name": 1}.',
      );
      return;
    }
    write({ secret: false, value: parsed });
  };
  return (
    <div className="flex flex-col gap-1">
      <Textarea
        aria-label={def.label}
        value={draft}
        disabled={disabled}
        spellCheck={false}
        aria-invalid={wrong !== null}
        placeholder={list ? "[]" : "{}"}
        rows={Math.min(10, Math.max(3, draft.split("\n").length))}
        className="font-mono text-xs dark:bg-transparent"
        onChange={(event) => {
          setDraft(event.target.value);
          setWrong(null);
        }}
        onBlur={commit}
        onKeyDown={(event) =>
          revertOnEscape(event, draft !== inForce, () => {
            setDraft(inForce);
            setWrong(null);
          })
        }
      />
      {wrong !== null && (
        <p role="alert" className="text-xs text-bad-ink">
          {wrong}
        </p>
      )}
    </div>
  );
}
