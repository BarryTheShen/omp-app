import type {
  FormBlock,
  FormChoiceField,
  FormDialog as FormDialogParams,
  FormSpan,
  FormTextField,
  HostDialogAnswer,
} from "@omp-app/contracts/chat-host";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { isImeEnter } from "../keys/ime";
import { KEYS, keycap } from "../keys/table";
import { matchesHotkey } from "../tour/keys";
import {
  type ChoiceValue,
  type FieldValue,
  formAnswer,
  formErrors,
  initialValues,
  type TextValue,
} from "./form-answer";
import { clock, useSecondsLeft } from "./QuestionsDialog";

/** The round mark of Other…: no option index is a string. */
const OTHER = "other";

/** A choice's row, all of it its target: on a phone 44 px for one line (#2816), the mark beside its first line. */
const CHOICE_ROW = "flex items-start gap-2.5 max-sm:py-[13px]";

/** The input types a one-line box keeps from the form; any other is plain text (a range is typed as a number). */
const INPUT_TYPES = new Set([
  "number",
  "email",
  "url",
  "tel",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
]);

/** A form's text: its words with omp's emphasis (code, bold, italic), and nothing else of the HTML it came from. */
function Spans({ spans }: { readonly spans: readonly FormSpan[] }): ReactNode {
  return spans.map((span, index) => {
    const key = `${index}:${span.text.slice(0, 12)}`;
    if (span.style === "code")
      return (
        <code key={key} className="rounded bg-(--code-bg) px-1 font-mono text-[0.9em]">
          {span.text}
        </code>
      );
    if (span.style === "strong") return <strong key={key}>{span.text}</strong>;
    if (span.style === "em") return <em key={key}>{span.text}</em>;
    return <span key={key}>{span.text}</span>;
  });
}

const textOf = (spans: readonly FormSpan[]): string =>
  spans
    .map((span) => span.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();

/**
 * omp's question form (its `ask`, omp 18.18.3) as one card: the form's sections in order, each with its text, pictures
 * and fields (round marks, tick boxes, lists, one-line and longer boxes), Other… where omp offers it, omp's own checks
 * under a field, and Submit. Skip (Esc) leaves it unanswered, as Esc does in omp. Hide folds it to one line.
 */
export function FormDialog({
  dialog,
  busy,
  error,
  waiting,
  onAnswer,
}: {
  readonly dialog: FormDialogParams;
  readonly busy: boolean;
  readonly error: string | null;
  readonly waiting: number;
  readonly onAnswer: (answer: HostDialogAnswer) => void;
}): ReactNode {
  const [values, setValues] = useState<FieldValue[]>(() => initialValues(dialog));
  const [shownErrors, setShownErrors] = useState<ReadonlyMap<number, string>>(new Map());
  const [hidden, setHidden] = useState(false);
  const secondsLeft = useSecondsLeft(dialog.timeout);
  const root = useRef<HTMLDivElement>(null);
  // The folded line names the first question, and how many more there are, as the questions dialog's does.
  const firstQuestion = dialog.fields[0]?.question ?? "";
  const moreQuestions = dialog.fields.length - 1;

  const update = (index: number, value: FieldValue): void => {
    setValues((now) => now.map((old, at) => (at === index ? value : old)));
    // A field changed is checked again on the next Submit, not while it is typed in.
    setShownErrors((now) => {
      if (!now.has(index)) return now;
      const next = new Map(now);
      next.delete(index);
      return next;
    });
  };
  const submit = (): void => {
    const errors = formErrors(dialog, values);
    setShownErrors(errors);
    if (errors.size > 0) {
      const first = Math.min(...errors.keys());
      root.current
        ?.querySelector<HTMLElement>(`[data-field="${first}"] :is(input, textarea, button)`)
        ?.focus();
      return;
    }
    onAnswer(formAnswer(dialog, values));
  };
  const skip = (): void => onAnswer({ cancelled: true });

  // omp's Alt+H (`app.ask.hide`) anywhere in this chat's window (the workspace's `data-chat-pane`; the whole page where
  // no window holds the chat), as the questions dialog takes it; an open menu that takes the key first keeps it.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented || !matchesHotkey(event, KEYS.askHide.hotkey)) return;
      const pane = root.current?.closest("[data-chat-pane]") ?? document.body;
      if (!(event.target instanceof Node) || !pane.contains(event.target)) return;
      event.preventDefault();
      setHidden((value) => !value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onKeyDownCapture = (event: KeyboardEvent<HTMLElement>): void => {
    if (busy) return;
    if (event.key === "Escape") {
      event.preventDefault();
      skip();
      return;
    }
    // Enter sends, Shift+Enter starts a new line, as in every box of the app.
    if (event.key === "Enter" && !event.shiftKey && !isImeEnter(event)) {
      event.preventDefault();
      submit();
    }
  };

  const timer =
    secondsLeft === undefined ? null : (
      <span
        className="font-mono text-xs text-t3 tabular-nums"
        title="Sends the form as it was offered when the time runs out"
      >
        {clock(secondsLeft)}
      </span>
    );

  if (hidden)
    return (
      <div ref={root} className="flex min-h-0 flex-col">
        <section
          aria-label="Questions from omp, hidden"
          className="flex items-center gap-2 rounded-xl border border-l3 bg-card px-3 py-1.5 shadow-md"
        >
          {timer}
          <p className="min-w-0 flex-1 truncate text-sm">
            <span className="text-t3">Question </span>
            <span className="text-t1">{firstQuestion}</span>
            {moreQuestions > 0 && <span className="text-t3"> +{moreQuestions} more</span>}
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={skip}
            title="Skip without answering  Esc"
          >
            Skip
          </Button>
          <Button
            size="sm"
            onClick={() => setHidden(false)}
            title={`Show the questions  ${keycap(KEYS.askHide)}`}
          >
            Show
          </Button>
        </section>
      </div>
    );

  return (
    <div ref={root} className="flex min-h-0 flex-col">
      <section
        role="dialog"
        aria-label="Questions from omp"
        className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-l3 bg-card shadow-md"
        onKeyDownCapture={onKeyDownCapture}
      >
        <div data-form-body className="flex min-h-0 flex-col gap-3 overflow-y-auto px-3.5 py-3">
          {dialog.sections.map((section, sectionIndex) => (
            <section
              // Sections keep their order for the form's life.
              // biome-ignore lint/suspicious/noArrayIndexKey: a form's sections never move
              key={sectionIndex}
              aria-label={textOf(section.title) || undefined}
              className="flex flex-col gap-2.5"
            >
              {section.title.length > 0 && (
                <p className="font-medium whitespace-pre-wrap text-t1">
                  <Spans spans={section.title} />
                </p>
              )}
              {section.blocks.map((block, blockIndex) => (
                <Block
                  // biome-ignore lint/suspicious/noArrayIndexKey: a section's blocks never move
                  key={blockIndex}
                  block={block}
                  dialog={dialog}
                  values={values}
                  errors={shownErrors}
                  onChange={update}
                />
              ))}
            </section>
          ))}
        </div>
        {error !== null && <p className="shrink-0 px-3.5 pb-1 text-xs text-bad-ink">{error}</p>}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-l2 px-3.5 py-2">
          {timer}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setHidden(true)}
            title={`Hide until you are ready to answer  ${keycap(KEYS.askHide)}`}
          >
            Hide
          </Button>
          {waiting > 0 && (
            <span className="text-xs text-t3">
              {waiting === 1 ? "1 more is waiting." : `${waiting} more are waiting.`}
            </span>
          )}
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={skip}
            title="Leave the questions unanswered  Esc"
          >
            Skip
          </Button>
          <Button size="sm" disabled={busy} onClick={submit} title="Submit  Enter">
            Submit
          </Button>
        </div>
      </section>
    </div>
  );
}

function Block({
  block,
  dialog,
  values,
  errors,
  onChange,
}: {
  readonly block: FormBlock;
  readonly dialog: FormDialogParams;
  readonly values: readonly FieldValue[];
  readonly errors: ReadonlyMap<number, string>;
  readonly onChange: (index: number, value: FieldValue) => void;
}): ReactNode {
  switch (block.kind) {
    case "text":
      return (
        <p
          className={
            block.heading
              ? "font-medium whitespace-pre-wrap text-t1"
              : "whitespace-pre-wrap text-t2"
          }
        >
          <Spans spans={block.spans} />
        </p>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a list's items never move
        <li key={index}>
          <Spans spans={item} />
        </li>
      ));
      return block.ordered ? (
        <ol className="list-decimal pl-5 text-t2">{items}</ol>
      ) : (
        <ul className="list-disc pl-5 text-t2">{items}</ul>
      );
    }
    case "pre":
      return (
        <pre className="max-h-48 overflow-auto rounded-lg border border-l2 bg-(--code-bg) px-3 py-2 text-xs">
          {block.text}
        </pre>
      );
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <tbody>
              {block.rows.map((row, rowIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a table's rows never move
                <tr key={rowIndex} className="border-b border-l2">
                  {row.map((cell, cellIndex) =>
                    rowIndex < block.headerRows ? (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a row's cells never move
                      <th key={cellIndex} className="px-2 py-1 text-left font-medium text-t1">
                        <Spans spans={cell} />
                      </th>
                    ) : (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a row's cells never move
                      <td key={cellIndex} className="px-2 py-1 text-t2">
                        <Spans spans={cell} />
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "image":
      return block.src === null ? (
        <p className="text-xs text-t3">Picture not shown{block.alt ? `: ${block.alt}` : ""}</p>
      ) : (
        <img
          src={block.src}
          alt={block.alt}
          className="max-h-64 max-w-full self-start rounded-md border border-l2 object-contain"
        />
      );
    case "field": {
      const field = dialog.fields[block.index];
      const value = values[block.index];
      if (field === undefined || value === undefined) return null;
      const error = errors.get(block.index);
      return (
        <div data-field={block.index} className="flex flex-col gap-1.5">
          {field.kind === "choice" ? (
            <Choice
              field={field}
              value={value as ChoiceValue}
              invalid={error !== undefined}
              onChange={(next) => onChange(block.index, next)}
            />
          ) : (
            <Text
              field={field}
              value={value as TextValue}
              invalid={error !== undefined}
              onChange={(next) => onChange(block.index, next)}
            />
          )}
          {error !== undefined && <p className="text-xs text-bad-ink">{error}</p>}
        </div>
      );
    }
  }
}

function FieldLabel({ field }: { readonly field: FormChoiceField | FormTextField }): ReactNode {
  if (field.label.length === 0) return null;
  return (
    <p className="whitespace-pre-wrap text-t1">
      <Spans spans={field.label} />
      {field.required && <span className="text-xs text-t3"> (required)</span>}
    </p>
  );
}

const otherRow = (
  <span className="flex min-w-0 flex-col">
    <span className="text-t1">Other…</span>
    <span className="text-xs text-t3">Type your own answer</span>
  </span>
);

/** Round marks for one answer (a list's too), tick boxes for several, with Other… when omp offers it. */
function Choice({
  field,
  value,
  invalid,
  onChange,
}: {
  readonly field: FormChoiceField;
  readonly value: ChoiceValue;
  readonly invalid: boolean;
  readonly onChange: (value: ChoiceValue) => void;
}): ReactNode {
  const question = field.question;
  const otherOn = value.other !== undefined;
  return (
    <>
      <FieldLabel field={field} />
      {field.multi ? (
        <fieldset
          className="flex min-w-0 flex-col gap-2 max-sm:gap-0"
          aria-label={question || undefined}
        >
          {field.options.map((option, index) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: the tick box inside is the control
            // biome-ignore lint/suspicious/noArrayIndexKey: an option is its place in the list
            <label key={index} className={CHOICE_ROW}>
              <Checkbox
                className="mt-0.5"
                aria-label={textOf(option.label)}
                aria-invalid={invalid || undefined}
                disabled={option.disabled}
                checked={value.checked.includes(index)}
                onCheckedChange={(on) =>
                  onChange({
                    ...value,
                    checked:
                      on === true
                        ? [...value.checked.filter((at) => at !== index), index].sort(
                            (a, b) => a - b,
                          )
                        : value.checked.filter((at) => at !== index),
                  })
                }
              />
              <span className="break-words text-t1">
                <Spans spans={option.label} />
              </span>
            </label>
          ))}
          {field.other && (
            // biome-ignore lint/a11y/noLabelWithoutControl: the tick box inside is the control
            <label className={CHOICE_ROW}>
              <Checkbox
                className="mt-0.5"
                aria-label="Other…"
                checked={otherOn}
                onCheckedChange={(on) =>
                  onChange({ ...value, other: on === true ? "" : undefined })
                }
              />
              {otherRow}
            </label>
          )}
        </fieldset>
      ) : (
        <RadioGroup
          className="max-sm:gap-0"
          aria-label={question || undefined}
          aria-invalid={invalid || undefined}
          value={otherOn ? OTHER : value.checked[0] === undefined ? null : String(value.checked[0])}
          onValueChange={(picked) => {
            if (picked === OTHER) onChange({ checked: [], other: "" });
            else if (typeof picked === "string")
              onChange({ checked: [Number(picked)], other: undefined });
          }}
        >
          {field.options.map((option, index) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control
            // biome-ignore lint/suspicious/noArrayIndexKey: an option is its place in the list
            <label key={index} className={CHOICE_ROW}>
              <RadioGroupItem
                className="mt-0.5"
                value={String(index)}
                disabled={option.disabled}
                aria-label={textOf(option.label)}
              />
              <span className="break-words text-t1">
                <Spans spans={option.label} />
              </span>
            </label>
          ))}
          {field.other && (
            // biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control
            <label className={CHOICE_ROW}>
              <RadioGroupItem className="mt-0.5" value={OTHER} aria-label="Other…" />
              {otherRow}
            </label>
          )}
        </RadioGroup>
      )}
      {otherOn && (
        <Textarea
          data-typed
          rows={2}
          aria-label={question ? `Your own answer: ${question}` : "Your own answer"}
          placeholder="Type your own answer"
          value={value.other ?? ""}
          onChange={(event) => onChange({ ...value, other: event.target.value })}
        />
      )}
    </>
  );
}

/** A one-line box, or a longer one that grows with its text, with the form's own hint in it. */
function Text({
  field,
  value,
  invalid,
  onChange,
}: {
  readonly field: FormTextField;
  readonly value: TextValue;
  readonly invalid: boolean;
  readonly onChange: (value: TextValue) => void;
}): ReactNode {
  const label = field.question || undefined;
  return (
    <>
      <FieldLabel field={field} />
      {field.multiline ? (
        <Textarea
          data-typed
          rows={Math.max(2, Math.min(field.rows, 8))}
          aria-label={label}
          aria-invalid={invalid || undefined}
          placeholder={field.placeholder || undefined}
          value={value.text}
          onChange={(event) => onChange({ text: event.target.value })}
        />
      ) : (
        <Input
          type={
            field.type === "range" ? "number" : INPUT_TYPES.has(field.type) ? field.type : "text"
          }
          aria-label={label}
          aria-invalid={invalid || undefined}
          placeholder={field.placeholder || undefined}
          value={value.text}
          {...(field.min === undefined ? {} : { min: field.min })}
          {...(field.max === undefined ? {} : { max: field.max })}
          onChange={(event) => onChange({ text: event.target.value })}
        />
      )}
    </>
  );
}
