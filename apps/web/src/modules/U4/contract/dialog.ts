/**
 * U4's modal dialog request contracts (browser-only), built from the chat host's dialogs (`ui.select`, `ui.confirm`,
 * `ui.input`, `ui.editor`, `ui.ask`, `ui.approve`; `contracts/chat-host/dialogs.ts`) and C0's branded `UiRequestId`.
 * Request state itself stays in R0 (`pending.dialogs`, answered through R0's actions); these types describe how one
 * request is presented, never a second request store.
 *
 * Dialog grammar (`modules/U4/README.md`, "Dialog grammar"): `select`, `confirm`, `input`, `editor`, rich `ask` and
 * `approve` are modal (one at a time per thread, FIFO, through `DialogHost`). The host's UI events that need no answer
 * are non-modal presentation handoffs (see `presentation.ts`), and its `ui_cancel` closes an open dialog.
 */

import type { CapabilityKey } from "@omp-app/contracts";
import { UiRequestId } from "@omp-app/contracts";
import {
  ApproveAnswer,
  type ApproveDialog,
  type HostDialogRequest,
} from "@omp-app/contracts/chat-host";
import { z } from "zod";

/** `omp.ui` gates omp's dialogs; app-origin dialogs settle locally. The `set_ask_dialog` command additionally gates
 *  rich `ask` (`research/modules/U4.md` §3.4). */
export const DIALOG_CAPABILITY: CapabilityKey = "omp.ui";
export const ASK_DIALOG_CAPABILITY: CapabilityKey = "omp.cmd.set_ask_dialog";

/** The dialog kinds `DialogHost` presents as a modal dialog. */
export const DIALOG_REQUEST_KINDS = [
  "select",
  "confirm",
  "input",
  "editor",
  "ask",
  "approve",
] as const;
export type DialogRequestKind = (typeof DIALOG_REQUEST_KINDS)[number];

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
  /** Index into `options` of the recommended choice: the dialog marks it, and omp picks it when the question times out. */
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
  /** App-owned questions use two plain decision buttons; omp approvals keep the deny-safe grammar. */
  variant: z.enum(["approval", "question"]).optional(),
  timeoutMs: TimeoutMs.optional(),
});
export type ConfirmDialogRequest = z.infer<typeof ConfirmDialogRequestSchema>;

export const InputDialogRequestSchema = z.strictObject({
  kind: z.literal("input"),
  id: UiRequestId,
  title: z.string().min(1),
  placeholder: z.string().min(1).optional(),
  timeoutMs: TimeoutMs.optional(),
  /**
   * App dialogs only: an empty answer is allowed and means "skip". `toDialogRequest` never sets it,
   * so omp's own input requests always require a value.
   */
  optional: z.boolean().optional(),
});
export type InputDialogRequest = z.infer<typeof InputDialogRequestSchema>;

export const EditorDialogRequestSchema = z.strictObject({
  kind: z.literal("editor"),
  id: UiRequestId,
  title: z.string().min(1),
  /** May be empty: an editor can open blank. No wire timeout (`research/modules/U4.md` §3.3). */
  prefill: z.string().optional(),
  promptStyle: z.boolean().optional(),
  /**
   * App dialogs only: the text is shown to select and copy by hand. It cannot be changed, the only
   * button is Done, and nothing is saved. `toDialogRequest` never sets it.
   */
  readOnly: z.boolean().optional(),
});
export type EditorDialogRequest = z.infer<typeof EditorDialogRequestSchema>;

export const AskDialogRequestSchema = z.strictObject({
  kind: z.literal("ask"),
  id: UiRequestId,
  questions: z.array(AskQuestionSchema).min(1),
  timeoutMs: TimeoutMs.optional(),
});
export type AskDialogRequest = z.infer<typeof AskDialogRequestSchema>;

const ApprovalChoiceSchema = z.strictObject({
  label: z.string().min(1),
  /** omp's own answer for this choice: this call, this session, no, or one of the prompt's grants. */
  answer: ApproveAnswer,
});
export type ApprovalChoice = z.infer<typeof ApprovalChoiceSchema>;

/**
 * A tool approval with omp's typed choices (`ui.approve`): each choice carries the answer omp takes for it, so the
 * answer never depends on matching a label (issue 2361).
 */
export const ApproveDialogRequestSchema = z.strictObject({
  kind: z.literal("approve"),
  id: UiRequestId,
  /** omp's full prompt: the tool, its reason and its details. */
  title: z.string().min(1),
  choices: z.array(ApprovalChoiceSchema).min(1),
  timeoutMs: TimeoutMs.optional(),
});
export type ApproveDialogRequest = z.infer<typeof ApproveDialogRequestSchema>;

export const DialogRequestSchema = z.discriminatedUnion("kind", [
  SelectDialogRequestSchema,
  ConfirmDialogRequestSchema,
  InputDialogRequestSchema,
  EditorDialogRequestSchema,
  AskDialogRequestSchema,
  ApproveDialogRequestSchema,
]);
export type DialogRequest = z.infer<typeof DialogRequestSchema>;

/** The heading of an ask dialog. An ask has no title of its own, so its dialog is named by this heading. */
export const ASK_DIALOG_HEADING = "Answer questions";

/**
 * The name an open dialog announces: its visible heading. A select, confirm, input or editor is named by its title, the
 * heading it shows. An ask is named by its fixed heading, because its question changes from one to the next.
 */
export function dialogName(request: DialogRequest): string {
  return request.kind === "ask" ? ASK_DIALOG_HEADING : request.title;
}

/**
 * omp's approval choices in omp's order and words (18.12.6 `tools/approval.ts:740-759`, the labels it shows a host
 * without an approval dialog): each grant for this session, each grant across sessions, this call only, this session
 * when offered, and Deny; each with the answer omp takes for it.
 */
export function approvalChoices(prompt: ApproveDialog["prompt"]): ApprovalChoice[] {
  const grants = prompt.grants ?? [];
  return [
    ...grants.map((grant) => ({
      label: grant.label,
      answer: { grant: grant.scope, always: false } as const,
    })),
    ...grants.map((grant) => ({
      label: grant.alwaysLabel,
      answer: { grant: grant.scope, always: true } as const,
    })),
    { label: grants.length > 0 ? "Approve Once" : "Approve", answer: "once" as const },
    ...(prompt.session ? [{ label: prompt.session, answer: "session" as const }] : []),
    { label: "Deny", answer: "deny" as const },
  ];
}

/** Converts one of the chat host's dialogs into a `DialogRequest`, branding `id` and keeping omp's field values. */
export function toDialogRequest(request: HostDialogRequest): DialogRequest {
  const id = UiRequestId.parse(request.id);
  switch (request.method) {
    case "ui.select":
      return {
        kind: "select",
        id,
        title: request.params.title,
        options: [...request.params.options],
        optionDetails: request.params.optionDetails?.map((detail) => ({ ...detail })),
        timeoutMs: request.params.timeout,
      };
    case "ui.confirm":
      return {
        kind: "confirm",
        id,
        title: request.params.title,
        message: request.params.message,
        timeoutMs: request.params.timeout,
      };
    case "ui.input":
      return {
        kind: "input",
        id,
        title: request.params.title,
        placeholder: request.params.placeholder,
        timeoutMs: request.params.timeout,
      };
    case "ui.editor":
      return {
        kind: "editor",
        id,
        title: request.params.title,
        prefill: request.params.prefill,
        promptStyle: request.params.promptStyle,
      };
    case "ui.ask":
      return {
        kind: "ask",
        id,
        questions: request.params.questions.map((question) => ({
          ...question,
          options: question.options.map((option) => ({ ...option })),
        })),
        timeoutMs: request.params.timeout,
      };
    case "ui.approve":
      return {
        kind: "approve",
        id,
        title: request.params.prompt.full,
        choices: approvalChoices(request.params.prompt),
        timeoutMs: request.params.timeout,
      };
  }
}
