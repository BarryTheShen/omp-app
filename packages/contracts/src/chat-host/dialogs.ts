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
