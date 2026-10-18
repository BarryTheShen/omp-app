import type { AppError, ProviderErrorResult } from "@omp-app/contracts";
import { InlineError } from "@/components/blocks";
import {
  answerErrorStatus,
  type CredentialFailure,
  credentialFailureFromStatusError,
} from "@/modules/D3/auth/credential";
import { CredentialFailureNotice } from "@/modules/D3/auth/credential-notice";

/** How an answer that did not finish normally ended. */
export type MessageEnding =
  | { readonly kind: "error"; readonly text: string | undefined; readonly details?: string }
  | { readonly kind: "credential"; readonly failure: CredentialFailure }
  | { readonly kind: "interrupted" }
  | { readonly kind: "length" };

const MAX_ERROR_CHARACTERS = 600;

/**
 * The ending of an assistant message, from the status R0 gives it: an error with omp's own words, a
 * stop (the person's or omp's), or the length limit. A message that finished, or is still running,
 * has none.
 */
export function endingOf(
  message: {
    readonly role: string;
    readonly status?: { readonly type: string; readonly reason?: string; readonly error?: unknown };
  },
  providerError?: ProviderErrorResult,
): MessageEnding | undefined {
  if (message.role !== "assistant" || message.status?.type !== "incomplete") return undefined;
  switch (message.status.reason) {
    case "error": {
      const failure = credentialFailureFromStatusError(message.status.error);
      if (failure !== null) return { kind: "credential", failure };
      if (providerError !== undefined) {
        return {
          kind: "error",
          text: providerError.message === "" ? undefined : providerError.message,
          ...(providerError.requestLogSaveFailureReason
            ? {
                details: `The request log could not be saved: ${providerError.requestLogSaveFailureReason}`,
              }
            : {}),
        };
      }
      return { kind: "error", text: undefined };
    }
    case "cancelled":
      return { kind: "interrupted" };
    case "length":
      return { kind: "length" };
    default:
      return undefined;
  }
}

/**
 * Whether the most recent answer omp ended with an error already says this failed prompt: the prompt
 * error and that answer are the same provider failure when both carry the same HTTP status. The
 * status is omp's typed field; the browser never compares omp's words (AP4).
 */
export function failureShownUnderAnswer(error: AppError | null, answer: unknown): boolean {
  const httpStatus = error?.omp?.httpStatus;
  return (
    error?.code === "omp_error" &&
    httpStatus !== undefined &&
    answerErrorStatus(answer) === httpStatus
  );
}

export function StrippedToolCallsNote({ count }: { readonly count: number }) {
  return (
    <p
      className="text-muted-foreground mt-2 text-sm italic"
      data-ending="stripped-tool-calls"
      data-slot="u1-message-ending"
    >
      {count} tool call{count === 1 ? "" : "s"} elided — no result on this branch
    </p>
  );
}

/** One line under an answer saying why it stopped, in plain words. */
export function MessageEndingNote({ ending }: { readonly ending: MessageEnding }) {
  switch (ending.kind) {
    case "credential":
      return (
        <div data-ending="credential" data-slot="u1-message-ending">
          <CredentialFailureNotice failure={ending.failure} variant="message" />
        </div>
      );
    case "error":
      return (
        <div data-ending="error" data-slot="u1-message-ending">
          <InlineError
            heading="The model stopped with an error"
            message={
              ending.text === undefined
                ? ""
                : ending.text.length > MAX_ERROR_CHARACTERS
                  ? `${ending.text.slice(0, MAX_ERROR_CHARACTERS)}…`
                  : ending.text
            }
            details={ending.details}
            variant="message"
          />
        </div>
      );
    case "interrupted":
      return (
        <p
          className="text-muted-foreground mt-2 text-sm"
          data-ending="interrupted"
          data-slot="u1-message-ending"
        >
          Interrupted
        </p>
      );
    case "length":
      return (
        <p
          className="text-muted-foreground mt-2 text-sm"
          data-ending="length"
          data-slot="u1-message-ending"
        >
          Cut off at the length limit
        </p>
      );
  }
}
