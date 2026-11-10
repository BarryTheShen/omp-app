/**
 * The values of omp's question form (`FormDialog`, omp 18.18.3) while a person fills it in, omp's own checks on them,
 * and the answer the host turns into omp's form data. The checks are omp's (pi-tui `html-form/data.ts`, `fieldError`, at
 * 18.18.5), so the card refuses what omp's own form refuses, in omp's words.
 */
import type {
  FormAnswer,
  FormChoiceField,
  FormDialog,
  FormField,
  FormTextField,
} from "@omp-app/contracts/chat-host";

/** A choice's ticked options (indexes) and its Other… text; `other` is undefined while Other… is not chosen. */
export interface ChoiceValue {
  readonly checked: readonly number[];
  readonly other: string | undefined;
}

/** A text field's text. */
export interface TextValue {
  readonly text: string;
}

export type FieldValue = ChoiceValue | TextValue;

/** Whether a choice gives a list (tick boxes of two or more, a list that takes several): omp's `isArrayChoice`. */
export function isArrayChoice(field: FormChoiceField): boolean {
  return field.multi && field.options.length > 1;
}

/** What each field holds when the form opens: the options it ticks and the text it fills in. */
export function initialValues(dialog: FormDialog): FieldValue[] {
  return dialog.fields.map((field): FieldValue => {
    if (field.kind === "text") return { text: field.value };
    const checked = field.options.flatMap((option, index) => (option.checked ? [index] : []));
    // A round mark takes one: omp's value is the first ticked.
    return { checked: field.multi ? checked : checked.slice(0, 1), other: undefined };
  });
}

/** Whether a choice has an answer: an option that can be picked, or Other…'s text (blank text is no answer). */
function choiceAnswered(field: FormChoiceField, value: ChoiceValue): boolean {
  const typed = field.other ? (value.other ?? "").trim() : "";
  return typed !== "" || value.checked.some((index) => field.options[index]?.disabled === false);
}

/** omp's own pattern check: anchored as HTML anchors it; a pattern that is not valid checks nothing. */
function matchesPattern(pattern: string, text: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`, "v").test(text);
  } catch {
    return true;
  }
}

function textError(field: FormTextField, text: string): string | undefined {
  if (text.trim() === "") return field.required ? "Required" : undefined;
  if (field.type === "number" || field.type === "range") {
    const number = Number(text);
    if (!Number.isFinite(number)) return "Enter a number";
    if (field.min !== undefined && number < field.min) return `Must be at least ${field.min}`;
    if (field.max !== undefined && number > field.max) return `Must be at most ${field.max}`;
  }
  if (field.minLength !== undefined && text.length < field.minLength)
    return `Needs at least ${field.minLength} characters`;
  if (field.maxLength !== undefined && text.length > field.maxLength)
    return `At most ${field.maxLength} characters`;
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return "Enter an email address";
  if (field.type === "url" && !URL.canParse(text)) return "Enter a full URL";
  if (field.pattern && !matchesPattern(field.pattern, text)) {
    return `Must match ${field.pattern.length > 40 ? `${field.pattern.slice(0, 39)}…` : field.pattern}`;
  }
  return undefined;
}

/** Why a field's value is not an answer omp takes, in omp's words; undefined when it is. */
export function fieldError(field: FormField, value: FieldValue): string | undefined {
  if (field.kind === "text") return textError(field, "text" in value ? value.text : "");
  if (!field.required || ("checked" in value && choiceAnswered(field, value))) return undefined;
  return isArrayChoice(field) ? "Select at least one" : "Required";
}

/** Each field's error, by its index; empty when the form can be sent. */
export function formErrors(dialog: FormDialog, values: readonly FieldValue[]): Map<number, string> {
  const errors = new Map<number, string>();
  dialog.fields.forEach((field, index) => {
    const value = values[index];
    const error = value === undefined ? undefined : fieldError(field, value);
    if (error !== undefined) errors.set(index, error);
  });
  return errors;
}

/** The answer the host turns into omp's form data: one entry per field, in the form's order. */
export function formAnswer(
  dialog: FormDialog,
  values: readonly FieldValue[],
): Extract<FormAnswer, { readonly fields: unknown }> {
  return {
    fields: dialog.fields.map((field, index) => {
      const value = values[index];
      if (field.kind === "text")
        return { text: value !== undefined && "text" in value ? value.text : "" };
      const choice =
        value !== undefined && "checked" in value ? value : { checked: [], other: undefined };
      return {
        checked: [...choice.checked],
        ...(field.other && choice.other !== undefined ? { other: choice.other } : {}),
      };
    }),
  };
}
