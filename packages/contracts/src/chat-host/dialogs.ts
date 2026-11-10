/**
 * Requests from the host (SDK plan H5.2d): the dialogs of the host's UI context, which the server shows and answers,
 * and the UI events that need no answer. Params and answers are omp's own fields (18.12.6
 * `modes/rpc/rpc-mode.ts:1030-1276`; the approval prompt from `tools/approval.ts:715-737`).
 */
import type {
  ExtensionApprovalAnswer,
  ExtensionApprovalPrompt,
  ExtensionWidgetOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { z } from "zod";

/** The dialog closed without an answer; `timedOut` when the server's own countdown ran out. */
const Cancelled = z.object({ cancelled: z.literal(true), timedOut: z.boolean().optional() });

export const ValueAnswer = z.union([z.object({ value: z.string() }), Cancelled]);
export type ValueAnswer = z.infer<typeof ValueAnswer>;

export const ConfirmAnswer = z.union([z.object({ confirmed: z.boolean() }), Cancelled]);
export type ConfirmAnswer = z.infer<typeof ConfirmAnswer>;

/**
 * One answer per question, in question order; the host checks them against the questions as omp does. `note` is a note
 * on the answer, which omp passes to the agent with it (omp's ask dialog, `n`).
 */
export const AskAnswer = z.union([
  z.object({
    answers: z.array(
      z.object({
        id: z.string(),
        selectedOptions: z.array(z.string()),
        customInput: z.string().optional(),
        note: z.string().optional(),
      }),
    ),
  }),
  Cancelled,
]);
export type AskAnswer = z.infer<typeof AskAnswer>;

/**
 * The answer to omp's form (`ui.form`), one entry per field in the form's order: a choice's ticked options (their
 * indexes) and its Other… text, or a text field's text. The host makes omp's form data from it with omp's own rules
 * (pi-tui `html-form/data.ts`: numbers, Other…, options that cannot be picked). `timedOut` when the page's countdown
 * sent the form as it stood.
 */
export const FormAnswer = z.union([
  z.object({
    fields: z.array(
      z.union([
        z.object({
          checked: z.array(z.number().int().nonnegative()),
          other: z.string().optional(),
        }),
        z.object({ text: z.string() }),
      ]),
    ),
    timedOut: z.boolean().optional(),
  }),
  Cancelled,
]);
export type FormAnswer = z.infer<typeof FormAnswer>;

/** omp's approval answer: this call, this session, no, or one of the prompt's grants. */
export const ApproveAnswer = z.union([
  z.enum(["once", "session", "deny"]),
  z.object({ grant: z.enum(["folder", "target"]), always: z.boolean() }),
]) satisfies z.ZodType<ExtensionApprovalAnswer>;
export type ApproveAnswer = z.infer<typeof ApproveAnswer>;

interface Timed {
  /** Milliseconds omp waits before it closes the dialog itself. */
  readonly timeout?: number;
}

export interface SelectDialog extends Timed {
  readonly title: string;
  readonly options: readonly string[];
  /** A description per option, aligned with `options`, when any option has one. */
  readonly optionDetails?: readonly { readonly description?: string }[];
  /** The option highlighted first (omp's `initialIndex`). */
  readonly initialIndex?: number;
}

export interface ConfirmDialog extends Timed {
  readonly title: string;
  readonly message: string;
}

/** The page a sign-in waits on, and what is signed in to: an omp provider's name, or an MCP server's. */
export interface SignInLink {
  readonly url: string;
  readonly name: string;
}

export interface InputDialog extends Timed {
  readonly title: string;
  readonly placeholder?: string;
  /**
   * Set when the question is a sign-in's (#2784): its page, shown with the question to open or copy wherever the
   * question is answered, and how Settings finds the question. A cancelled answer stops the sign-in.
   */
  readonly signIn?: SignInLink;
}

export interface EditorDialog {
  readonly title: string;
  readonly prefill?: string;
  readonly promptStyle?: boolean;
}

export interface AskDialog extends Timed {
  readonly questions: readonly ExtensionAskDialogQuestion[];
}

/** A run of a form's text with its emphasis (omp's `FormSpan`); `"\n"` in `text` is a line break. */
export interface FormSpan {
  readonly text: string;
  readonly style?: "code" | "strong" | "em";
}

/** One answer of a choice: its label, and whether it is ticked at the start or cannot be picked. */
export interface FormChoiceOption {
  readonly label: readonly FormSpan[];
  readonly checked: boolean;
  readonly disabled: boolean;
}

/** Round marks (`multi: false`), tick boxes (`multi: true`) or a list (`select`), with Other… when `other`. */
export interface FormChoiceField {
  readonly kind: "choice";
  /** The question it answers, in one line, as omp words it (`fieldQuestions`): its label, else the text above it. */
  readonly question: string;
  readonly multi: boolean;
  readonly select: boolean;
  readonly other: boolean;
  /** The control's own label; empty for round marks and tick boxes, whose question is the text above them. */
  readonly label: readonly FormSpan[];
  readonly options: readonly FormChoiceOption[];
  readonly required: boolean;
}

/** A one-line box (`multiline: false`) or a box of several lines, with omp's checks on its text. */
export interface FormTextField {
  readonly kind: "text";
  /** The question it answers, in one line, as omp words it (`fieldQuestions`): its label, else the text above it. */
  readonly question: string;
  /** The input's type (`text`, `number`, `email`, `url`, …); `textarea` for a box of several lines. */
  readonly type: string;
  readonly multiline: boolean;
  readonly label: readonly FormSpan[];
  /** The text it starts with. */
  readonly value: string;
  readonly placeholder: string;
  readonly required: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  /** The lines a box of several lines asked for; 1 for a one-line box. */
  readonly rows: number;
}

export type FormField = FormChoiceField | FormTextField;

/** What a form shows, in order: text, a list, preformatted text, a table, a picture, or one of its fields. */
export type FormBlock =
  | { readonly kind: "text"; readonly spans: readonly FormSpan[]; readonly heading: boolean }
  | {
      readonly kind: "list";
      readonly items: readonly (readonly FormSpan[])[];
      readonly ordered: boolean;
    }
  | { readonly kind: "pre"; readonly text: string }
  | {
      readonly kind: "table";
      readonly rows: readonly (readonly (readonly FormSpan[])[])[];
      readonly headerRows: number;
    }
  /** A picture the host loaded, as a `data:` URL; null when it could not, and `alt` says what it was. */
  | { readonly kind: "image"; readonly src: string | null; readonly alt: string }
  /** The field at this index of `fields`. */
  | { readonly kind: "field"; readonly index: number };

/** A part of the form: a titled `<fieldset>`, or untitled content between them. */
export interface FormSection {
  readonly title: readonly FormSpan[];
  readonly blocks: readonly FormBlock[];
}

/**
 * omp's question form (its `ask` tool, omp 18.18.3), as the host reads it with omp's own parser (pi-tui
 * `html-form/parse.ts`): text, pictures and fields only. Nothing in it is HTML, so nothing the form's author wrote can
 * run in a page; the pictures are `data:` URLs the host loaded, so no page fetches an address the form names.
 */
export interface FormDialog extends Timed {
  readonly sections: readonly FormSection[];
  readonly fields: readonly FormField[];
}

/** A tool approval with omp's own choices: `once` is always among them, so a host never matches labels to find it. */
export interface ApproveDialog extends Timed {
  readonly prompt: ExtensionApprovalPrompt;
}

// UI events: no answer.

/** omp closed a dialog itself (its signal aborted or its timeout passed): the server closes it too. */
export interface UiCancelEvent {
  readonly type: "ui_cancel";
  readonly requestId: string;
}

/**
 * A dialog was answered from a page that shows the chat: every other page closes it too (#2809). The server writes it
 * when it takes the answer; omp does not. A page that does not know it shows the dialog until the chat opens again.
 */
export interface UiAnsweredEvent {
  readonly type: "ui_answered";
  readonly requestId: string;
}

export interface UiNotifyEvent {
  readonly type: "ui_notify";
  readonly message: string;
  readonly notifyType?: "info" | "warning" | "error";
}

/** An extension's status line; no text clears it. */
export interface UiStatusEvent {
  readonly type: "ui_status";
  readonly statusKey: string;
  readonly statusText?: string;
}

/** An extension's widget as lines; no lines clear it. Widgets that are components stay terminal-only, as in omp. */
export interface UiWidgetEvent {
  readonly type: "ui_widget";
  readonly widgetKey: string;
  readonly widgetLines?: readonly string[];
  readonly widgetPlacement?: ExtensionWidgetOptions["placement"];
  /** The app whose lite view alone shows it (`setWidget(key, lines, { host })`); every view shows one without. */
  readonly widgetHost?: string;
}

export interface UiTitleEvent {
  readonly type: "ui_title";
  readonly title: string;
}

/** An extension set the composer's text. */
export interface UiEditorTextEvent {
  readonly type: "ui_editor_text";
  readonly text: string;
}

/** A sign-in's page to open (omp's `onAuth`); the sign-in goes on without an answer. */
export interface UiOpenUrlEvent {
  readonly type: "ui_open_url";
  readonly url: string;
  /** A short local link that redirects to `url`, when the sign-in runs one. */
  readonly launchUrl?: string;
  readonly instructions?: string;
}

export type UiEvent =
  | UiCancelEvent
  | UiNotifyEvent
  | UiStatusEvent
  | UiWidgetEvent
  | UiTitleEvent
  | UiEditorTextEvent
  | UiOpenUrlEvent;

/** The UI events that need no answer: everything but `ui_cancel`, which closes a dialog. */
export type UiPresentationEvent = Exclude<UiEvent, UiCancelEvent>;
