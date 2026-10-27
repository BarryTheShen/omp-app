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

/** One answer per question, in question order; the host checks them against the questions as omp does. */
export const AskAnswer = z.union([
  z.object({
    answers: z.array(
      z.object({
        id: z.string(),
        selectedOptions: z.array(z.string()),
        customInput: z.string().optional(),
      }),
    ),
  }),
  Cancelled,
]);
export type AskAnswer = z.infer<typeof AskAnswer>;

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

export interface InputDialog extends Timed {
  readonly title: string;
  readonly placeholder?: string;
}

export interface EditorDialog {
  readonly title: string;
  readonly prefill?: string;
  readonly promptStyle?: boolean;
}

export interface AskDialog extends Timed {
  readonly questions: readonly ExtensionAskDialogQuestion[];
}

/** A tool approval with omp's own choices: `once` is always among them, so a host never matches labels to find it. */
export interface ApproveDialog extends Timed {
  readonly prompt: ExtensionApprovalPrompt;
}

/** The requests a host sends; the server answers each with one response. */
export interface ChatHostHostMethodMap {
  readonly "ui.select": { readonly params: SelectDialog; readonly result: ValueAnswer };
  readonly "ui.confirm": { readonly params: ConfirmDialog; readonly result: ConfirmAnswer };
  readonly "ui.input": { readonly params: InputDialog; readonly result: ValueAnswer };
  readonly "ui.editor": { readonly params: EditorDialog; readonly result: ValueAnswer };
  /** Sent only after the server turned the ask dialog on (`set_ask_dialog`). */
  readonly "ui.ask": { readonly params: AskDialog; readonly result: AskAnswer };
  readonly "ui.approve": { readonly params: ApproveDialog; readonly result: ApproveAnswer };
}
export type ChatHostHostMethod = keyof ChatHostHostMethodMap;

/** Checks each answer the server sends before omp sees it. */
export const HOST_METHOD_ANSWERS: {
  readonly [M in ChatHostHostMethod]: z.ZodType<ChatHostHostMethodMap[M]["result"]>;
} = {
  "ui.select": ValueAnswer,
  "ui.confirm": ConfirmAnswer,
  "ui.input": ValueAnswer,
  "ui.editor": ValueAnswer,
  "ui.ask": AskAnswer,
  "ui.approve": ApproveAnswer,
};

/** Whether a host's request names one of the host's methods; never an object's inherited names. */
export function isChatHostHostMethod(method: string): method is ChatHostHostMethod {
  return Object.hasOwn(HOST_METHOD_ANSWERS, method);
}

// UI events: no answer.

/** omp closed a dialog itself (its signal aborted or its timeout passed): the server closes it too. */
export interface UiCancelEvent {
  readonly type: "ui_cancel";
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

export type UiEvent =
  | UiCancelEvent
  | UiNotifyEvent
  | UiStatusEvent
  | UiWidgetEvent
  | UiTitleEvent
  | UiEditorTextEvent;
