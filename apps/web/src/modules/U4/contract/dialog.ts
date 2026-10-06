/**
 * U4's modal dialog request contracts (browser-only). Built on C0's copied
 * `extension_ui_request` wire shapes (`research/modules/U4.md` §3.2) and C0's branded
 * `UiRequestId`. Request state itself stays in R0 (`R0.1` pending state, `R0.5` answers it);
 * these types describe how one request is presented, never a second request store.
 *
 * Dialog grammar (`modules/U4/README.md`, "Dialog grammar"): `select`, `confirm`, `input`,
 * `editor` and rich `ask` are modal (one at a time per thread, FIFO, through `DialogHost`).
 * `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` and `open_url` are non-modal
 * presentation handoffs (see `presentation.ts`). `cancel` is a correlation signal that targets an
 * already-open request; it is never presented as its own dialog or handoff.
 */

import type { CapabilityKey, OmpWire } from "@omp-app/contracts";
import { AppFailure, UiRequestId } from "@omp-app/contracts";
import { z } from "zod";

/** `omp.ui` gates OMP-origin extension-UI requests; app-origin dialogs settle locally. The
 *  `set_ask_dialog` command additionally gates rich `ask` (`research/modules/U4.md` §3.4). */
export const DIALOG_CAPABILITY: CapabilityKey = "omp.ui";
export const ASK_DIALOG_CAPABILITY: CapabilityKey = "omp.cmd.set_ask_dialog";

/** The `extension_ui_request.method` values `DialogHost` presents as a modal dialog. */
export const DIALOG_REQUEST_KINDS = ["select", "confirm", "input", "editor", "ask"] as const;
export type DialogRequestKind = (typeof DIALOG_REQUEST_KINDS)[number];

/** The `extension_ui_request.method` values normalized as non-modal presentation handoffs. */
export const PRESENTATION_METHODS = [
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
  "open_url",
] as const;
export type PresentationMethod = (typeof PRESENTATION_METHODS)[number];

/** Targets an already-open request by id; the router closes it and ignores a later answer. */
export const CANCEL_METHOD = "cancel";

export type ExtensionUiMethod = OmpWire.ExtensionUiRequest["method"];

/** Classifies one wire method into the three grammar buckets (`modules/U4/README.md` rules 2-4). */
export function classifyExtensionUiMethod(
  method: ExtensionUiMethod,
): "modal" | "presentation" | "cancel" {
  if (method === CANCEL_METHOD) return "cancel";
  if ((DIALOG_REQUEST_KINDS as readonly string[]).includes(method)) return "modal";
  return "presentation";
}

const SelectOptionDetailSchema = z.strictObject({ description: z.string().min(1).optional() });
export type SelectOptionDetail = z.infer<typeof SelectOptionDetailSchema>;

const AskOptionSchema = z.strictObject({
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  preview: z.string().min(1).optional(),
});
export type AskOption = z.infer<typeof AskOptionSchema>;

const AskQuestionSchema = z.strictObject({
  id: z.string().min(1),
  question: z.string().min(1),
  header: z.string().min(1).optional(),
  options: z.array(AskOptionSchema).min(1),
  multi: z.boolean().optional(),
  /** Index into `options` of the recommended choice; used only on an omp timeout. */
  recommended: z.int().min(0).optional(),
});
export type AskQuestion = z.infer<typeof AskQuestionSchema>;

const TimeoutMs = z.int().positive();

export const SelectDialogRequestSchema = z.strictObject({
  kind: z.literal("select"),
  id: UiRequestId,
  title: z.string().min(1),
  options: z.array(z.string().min(1)).min(1),
  /** Positional with `options` (`research/modules/U4.md` §3.2). */
  optionDetails: z.array(SelectOptionDetailSchema).optional(),
  timeoutMs: TimeoutMs.optional(),
});
export type SelectDialogRequest = z.infer<typeof SelectDialogRequestSchema>;

export const ConfirmDialogRequestSchema = z.strictObject({
  kind: z.literal("confirm"),
  id: UiRequestId,
  title: z.string().min(1),
  message: z.string().min(1),
  timeoutMs: TimeoutMs.optional(),
});
export type ConfirmDialogRequest = z.infer<typeof ConfirmDialogRequestSchema>;

export const InputDialogRequestSchema = z.strictObject({
  kind: z.literal("input"),
  id: UiRequestId,
  title: z.string().min(1),
  placeholder: z.string().min(1).optional(),
  timeoutMs: TimeoutMs.optional(),
});
export type InputDialogRequest = z.infer<typeof InputDialogRequestSchema>;

export const EditorDialogRequestSchema = z.strictObject({
  kind: z.literal("editor"),
  id: UiRequestId,
  title: z.string().min(1),
  /** May be empty: an editor can open blank. No wire timeout (`research/modules/U4.md` §3.3). */
  prefill: z.string().optional(),
  promptStyle: z.boolean().optional(),
});
export type EditorDialogRequest = z.infer<typeof EditorDialogRequestSchema>;

export const AskDialogRequestSchema = z.strictObject({
  kind: z.literal("ask"),
  id: UiRequestId,
  questions: z.array(AskQuestionSchema).min(1),
  timeoutMs: TimeoutMs.optional(),
});
export type AskDialogRequest = z.infer<typeof AskDialogRequestSchema>;

export const DialogRequestSchema = z.discriminatedUnion("kind", [
  SelectDialogRequestSchema,
  ConfirmDialogRequestSchema,
  InputDialogRequestSchema,
  EditorDialogRequestSchema,
  AskDialogRequestSchema,
]);
export type DialogRequest = z.infer<typeof DialogRequestSchema>;

/**
 * Converts one omp `extension_ui_request` whose `method` is a modal kind into a `DialogRequest`,
 * branding `id` and keeping every field name exact (`modules/U4/README.md` Plan item 1). Throws
 * `AppFailure(internal)` for a non-modal method: callers classify first with
 * `classifyExtensionUiMethod`.
 */
export function toDialogRequest(request: OmpWire.ExtensionUiRequest): DialogRequest {
  const id = UiRequestId.parse(request.id);
  switch (request.method) {
    case "select":
      return {
        kind: "select",
        id,
        title: request.title,
        options: request.options,
        optionDetails: request.optionDetails,
        timeoutMs: request.timeout,
      };
    case "confirm":
      return {
        kind: "confirm",
        id,
        title: request.title,
        message: request.message,
        timeoutMs: request.timeout,
      };
    case "input":
      return {
        kind: "input",
        id,
        title: request.title,
        placeholder: request.placeholder,
        timeoutMs: request.timeout,
      };
    case "editor":
      return {
        kind: "editor",
        id,
        title: request.title,
        prefill: request.prefill,
        promptStyle: request.promptStyle,
      };
    case "ask":
      return { kind: "ask", id, questions: request.questions, timeoutMs: request.timeout };
    default:
      throw new AppFailure({
        code: "internal",
        message: `Expected a modal extension-UI request; got "${request.method}".`,
        retryable: false,
      });
  }
}
