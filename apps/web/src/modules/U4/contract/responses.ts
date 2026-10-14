/**
 * Dialog answers (`DialogResponse`/`DialogResult`) and the conservative defaults every feature
 * dialog inherits from `DialogHost` (`modules/U4/README.md` rule 6; `research/modules/U4.md` §3.3,
 * citing omp `docs/rpc.md` lines 1085-1093).
 */

import type { OmpWire, UiRequestId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { z } from "zod";
import type { AskDialogRequest, AskQuestion, ConfirmDialogRequest, DialogRequest } from "./dialog";
import { DIALOG_REQUEST_KINDS } from "./dialog";

const TrimmedNonEmpty = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), "must not have leading or trailing whitespace");

export const AskAnswerValueSchema = z
  .strictObject({
    id: z.string().min(1),
    /** May be empty: an `Other`-only answer, or a checkbox question answered with none ticked. */
    selectedOptions: z.array(z.string().min(1)),
    customInput: TrimmedNonEmpty.optional(),
  })
  .refine(
    (answer) => new Set(answer.selectedOptions).size === answer.selectedOptions.length,
    "selectedOptions must not repeat a label",
  );
export type AskAnswerValue = z.infer<typeof AskAnswerValueSchema>;

export const DialogResponseSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("select"), value: z.string().min(1) }),
  z.strictObject({ kind: z.literal("confirm"), confirmed: z.boolean() }),
  z.strictObject({ kind: z.literal("input"), value: z.string() }),
  z.strictObject({ kind: z.literal("editor"), value: z.string() }),
  z.strictObject({ kind: z.literal("ask"), answers: z.array(AskAnswerValueSchema).min(1) }),
]);
export type DialogResponse = z.infer<typeof DialogResponseSchema>;

export const DialogResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("answered"), response: DialogResponseSchema }),
  z.strictObject({
    outcome: z.literal("cancelled"),
    kind: z.enum(DIALOG_REQUEST_KINDS),
    timedOut: z.boolean(),
    // An editor or an input hands back the text in its box when it closes without an answer. No other kind sends it.
    draft: z.string().optional(),
  }),
]);
export type DialogResult = z.infer<typeof DialogResultSchema>;

/** The precise result shape for one request kind `R`, keeping `DialogHost.open<R>()` fully typed. */
export type DialogResultFor<R extends DialogRequest> =
  | {
      readonly outcome: "answered";
      readonly response: Extract<DialogResponse, { kind: R["kind"] }>;
    }
  | {
      readonly outcome: "cancelled";
      readonly kind: R["kind"];
      readonly timedOut: boolean;
      /** The text an editor or input held when it closed without an answer: Cancel, Escape, a press outside, or a host close. */
      readonly draft?: string;
    };

/**
 * omp resolves `select`/`input`/`editor` to no value and `ask` to its recommended-or-first
 * answers only on a true deadline, never on an explicit cancel (`docs/rpc.md` lines 1085-1093).
 * `confirm`'s own fail-closed `false` is `resolveConfirm`'s job, not this wire-level default: the
 * wire itself always answers a cancelled/timed-out `confirm` with `{ cancelled: true }`.
 *
 * The two casts below carry a generic `DialogResultFor<R>` whose branch this function just proved
 * at runtime (`request.kind` fixes the result's own `kind`/`response.kind`); TypeScript cannot
 * replay that proof through the conditional, so the narrowing is asserted once, here.
 */
export function defaultDialogResult<R extends DialogRequest>(
  request: R,
  reason: { readonly timedOut: boolean },
): DialogResultFor<R> {
  if (request.kind === "ask" && reason.timedOut) {
    const answers = defaultAskAnswers(request.questions);
    return { outcome: "answered", response: { kind: "ask", answers } } as DialogResultFor<R>;
  }
  return {
    outcome: "cancelled",
    kind: request.kind,
    timedOut: reason.timedOut,
  } as DialogResultFor<R>;
}

/**
 * omp's recommended-or-first rule for an `ask` timeout, one answer per question in request order
 * (`docs/rpc.md` lines 1090-1093). Throws `AppFailure(internal)` only when a question's own
 * `options` is empty, which the schema's `min(1)` already forbids for validated input.
 */
export function defaultAskAnswers(questions: readonly AskQuestion[]): readonly AskAnswerValue[] {
  return questions.map((question) => {
    const recommendedIndex = question.recommended ?? 0;
    const chosen = question.options[recommendedIndex] ?? question.options[0];
    if (!chosen) {
      throw new AppFailure({
        code: "internal",
        message: `Ask question "${question.id}" has no options to fall back to.`,
        retryable: false,
      });
    }
    return { id: question.id, selectedOptions: [chosen.label] };
  });
}

/**
 * The typed `confirm` helper's own default (`modules/U4/README.md`, "Dialog grammar"): cancelled,
 * timed out, or an explicit "No" all deny; only an explicit `confirmed: true` answer approves.
 */
export function resolveConfirm(result: DialogResultFor<ConfirmDialogRequest>): boolean {
  return result.outcome === "answered" && result.response.confirmed;
}

/**
 * Validates one `ask` answer set against its request: same length/order/ids as `questions`, exact
 * option labels, and a single-select question (`multi` falsy) accepts at most one option, cannot combine an option with
 * custom text, and needs an answer. A checkbox question may take none: omp accepts an empty selection (ask.ts:837).
 */
export function validateAskAnswers(
  request: AskDialogRequest,
  answers: readonly AskAnswerValue[],
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (answers.length !== request.questions.length) {
    return { ok: false, reason: "answers must have one entry per question, in order" };
  }
  for (const [index, question] of request.questions.entries()) {
    const answer = answers[index];
    if (!answer || answer.id !== question.id) {
      return { ok: false, reason: `answer ${index} must match question id "${question.id}"` };
    }
    const labels = new Set(question.options.map((option) => option.label));
    for (const selected of answer.selectedOptions) {
      if (!labels.has(selected)) {
        return { ok: false, reason: `"${selected}" is not an option of question "${question.id}"` };
      }
    }
    if (!question.multi && answer.selectedOptions.length > 1) {
      return { ok: false, reason: `question "${question.id}" is single-select` };
    }
    if (
      !question.multi &&
      answer.selectedOptions.length === 1 &&
      answer.customInput !== undefined
    ) {
      return {
        ok: false,
        reason: `question "${question.id}" cannot combine an option with custom text`,
      };
    }
    if (
      !question.multi &&
      answer.selectedOptions.length === 0 &&
      answer.customInput === undefined
    ) {
      return { ok: false, reason: `question "${question.id}" needs an answer` };
    }
  }
  return { ok: true };
}

/** Builds the exact `extension_ui_response` wire frame for one dialog result, preserving `id`. */
export function toWireExtensionUiResponse(
  id: UiRequestId,
  result: DialogResult,
): OmpWire.ExtensionUiResponse {
  if (result.outcome === "cancelled") {
    return result.timedOut
      ? { type: "extension_ui_response", id, cancelled: true, timedOut: true }
      : { type: "extension_ui_response", id, cancelled: true };
  }
  const { response } = result;
  switch (response.kind) {
    case "select":
    case "input":
    case "editor":
      return { type: "extension_ui_response", id, value: response.value };
    case "confirm":
      return { type: "extension_ui_response", id, confirmed: response.confirmed };
    case "ask":
      return {
        type: "extension_ui_response",
        id,
        answers: response.answers.map((answer) => ({
          id: answer.id,
          selectedOptions: [...answer.selectedOptions],
          customInput: answer.customInput,
        })),
      };
  }
}
