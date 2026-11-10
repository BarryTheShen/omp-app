/**
 * omp's question form (its `ask` tool, omp 18.18.3) in the app. The HTML the model wrote is read with omp's own parser
 * (pi-tui `html-form/parse.ts`) into data a page draws (`FormDialog`): text, pictures and fields, never HTML, so no
 * script, handler or style in it reaches a page. Pictures are loaded here, as omp's terminal loads them
 * (`html-form/media.ts`), and sent as `data:` URLs, so no page fetches an address the form names. The page's answer
 * becomes omp's form data by omp's own rules (`html-form/data.ts`).
 */

import {
  choiceValue,
  defaultFormData,
  fieldQuestions,
  type HtmlFormData,
  textValue,
} from "@oh-my-pi/pi-tui/html-form/data";
import { type FormMedia, loadFormImage, svgMedia } from "@oh-my-pi/pi-tui/html-form/media";
import {
  type HtmlForm,
  type FormBlock as OmpFormBlock,
  type FormField as OmpFormField,
  type FormSpan as OmpFormSpan,
  parseHtmlForm,
} from "@oh-my-pi/pi-tui/html-form/parse";
import type {
  FormAnswer,
  FormBlock,
  FormDialog,
  FormField,
  FormSpan,
} from "@omp-app/contracts/chat-host";

/** A form as omp parsed it, and as a page draws it. */
export interface ReadForm {
  readonly form: HtmlForm;
  readonly dialog: Pick<FormDialog, "sections" | "fields">;
}

/** A submitted answer: one entry per field, in the form's order. */
type SubmittedFields = Extract<FormAnswer, { readonly fields: unknown }>["fields"];

const spansOf = (spans: readonly OmpFormSpan[]): FormSpan[] =>
  spans.map((span) =>
    span.style === undefined ? { text: span.text } : { text: span.text, style: span.style },
  );

function fieldOf(field: OmpFormField, question: string): FormField {
  if (field.kind === "choice") {
    return {
      kind: "choice",
      question,
      multi: field.multi,
      select: field.select,
      other: field.other,
      label: spansOf(field.label),
      options: field.options.map((option) => ({
        label: spansOf(option.label),
        checked: option.checked,
        disabled: option.disabled,
      })),
      required: field.required,
    };
  }
  return {
    kind: "text",
    question,
    type: field.type,
    multiline: field.multiline,
    label: spansOf(field.label),
    value: field.value,
    placeholder: field.placeholder,
    required: field.required,
    ...(field.min === undefined ? {} : { min: field.min }),
    ...(field.max === undefined ? {} : { max: field.max }),
    ...(field.pattern === undefined ? {} : { pattern: field.pattern }),
    ...(field.minLength === undefined ? {} : { minLength: field.minLength }),
    ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
    rows: field.rows,
  };
}

const dataUrl = (media: FormMedia): string =>
  `data:${media.mime};base64,${Buffer.from(media.bytes).toString("base64")}`;

async function blockOf(
  block: OmpFormBlock,
  index: ReadonlyMap<OmpFormField, number>,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<FormBlock> {
  switch (block.kind) {
    case "text":
      return { kind: "text", spans: spansOf(block.spans), heading: block.heading };
    case "list":
      return { kind: "list", items: block.items.map(spansOf), ordered: block.ordered };
    case "pre":
      return { kind: "pre", text: block.text };
    case "table":
      return {
        kind: "table",
        rows: block.rows.map((row) => row.map(spansOf)),
        headerRows: block.headerRows,
      };
    case "image": {
      // omp loads only pictures (PNG, JPEG, GIF, WebP, SVG) up to 10 MiB; one it cannot load shows as its alt text.
      const src = await loadFormImage(block.src, {
        cwd,
        ...(signal === undefined ? {} : { signal }),
      }).then(dataUrl, () => null);
      return { kind: "image", src, alt: block.alt };
    }
    case "svg":
      // Drawn as a picture: a page shows an SVG picture without running anything in it.
      return { kind: "image", src: dataUrl(svgMedia(block.markup)), alt: block.alt };
    case "field":
      return { kind: "field", index: index.get(block.field) ?? -1 };
  }
}

/** The form's HTML read with omp's parser; its pictures loaded, relative to `cwd`. */
export async function readForm(html: string, cwd: string, signal?: AbortSignal): Promise<ReadForm> {
  const form = parseHtmlForm(html);
  const index = new Map(form.fields.map((field, position) => [field, position] as const));
  const sections = await Promise.all(
    form.sections.map(async (section) => ({
      title: spansOf(section.title),
      blocks: await Promise.all(section.blocks.map((block) => blockOf(block, index, cwd, signal))),
    })),
  );
  const questions = fieldQuestions(form);
  return {
    form,
    dialog: {
      sections,
      fields: form.fields.map((field) => fieldOf(field, questions.get(field) ?? field.name)),
    },
  };
}

/**
 * The page's answer as omp's form data: the hidden inputs, then each named field's value by omp's rules (a number for
 * a number box, Other…'s text among a choice's values, nothing from an option that cannot be picked). An answer that
 * does not fit the form is refused, as the ask dialog's is.
 */
export function formData(form: HtmlForm, fields: SubmittedFields): HtmlFormData {
  if (fields.length !== form.fields.length) {
    throw new Error(`The form's answer must carry ${form.fields.length} fields in form order`);
  }
  const data: HtmlFormData = {};
  for (const [name, value] of form.hidden) data[name] = value;
  form.fields.forEach((field, position) => {
    const given = fields[position];
    if (given === undefined || !field.name) return;
    let value: HtmlFormData[string] | undefined;
    if (field.kind === "text") {
      if (!("text" in given)) throw new Error(`The form's field ${field.name} takes text`);
      value = textValue(field, given.text);
    } else {
      if (!("checked" in given) || given.checked.some((option) => option >= field.options.length)) {
        throw new Error(
          `The form's field ${field.name} takes some of its ${field.options.length} options`,
        );
      }
      value = choiceValue(field, new Set(given.checked), given.other);
    }
    if (value !== undefined) data[field.name] = value;
  });
  return data;
}

/** What the form sends untouched, when its time runs out with no answer: omp's defaults. */
export function untouchedFormData(form: HtmlForm): HtmlFormData {
  return defaultFormData(form);
}
