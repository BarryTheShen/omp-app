import type { AppError } from "@omp-app/contracts";
import { z } from "zod";

/**
 * An answer the provider refused because the key or login omp used was not accepted (HTTP 401 or 403).
 * Read from omp's typed status only; the browser never reads omp's words to decide (AP4).
 */
export interface CredentialFailure {
  readonly httpStatus: 401 | 403;
  /** The provider omp called, as omp names it (for example `openai`). */
  readonly provider: string | undefined;
  /** The model omp called, as omp names it (for example `gpt-6-luna`). */
  readonly model: string | undefined;
  /** omp's own words for the failure; shown only under "Show details". */
  readonly text: string;
}

/** The fields omp writes on an assistant message that ended with an error (its session file). */
const ErroredAnswer = z.looseObject({
  role: z.string(),
  stopReason: z.string(),
  errorStatus: z.number().optional(),
  errorMessage: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  retryRecovery: z.looseObject({ status: z.string().optional() }).optional(),
});

/** A message status as this module writes it into the transcript (plain JSON). */
const CredentialStatusError = z.looseObject({
  text: z.string(),
  httpStatus: z.number(),
  provider: z.string().optional(),
  model: z.string().optional(),
});

function refusedStatus(value: number | undefined): 401 | 403 | undefined {
  return value === 401 || value === 403 ? value : undefined;
}

function words(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The failed prompt, which the banner carries as omp's `prompt_result` error (`AppError.omp`). */
export function credentialFailureFromError(error: AppError | null): CredentialFailure | null {
  if (error === null) return null;
  const httpStatus = refusedStatus(error.omp?.httpStatus);
  if (httpStatus === undefined) return null;
  return {
    httpStatus,
    provider: words(error.omp?.provider),
    model: words(error.omp?.model),
    text: error.message,
  };
}

/** An answer omp ended with an error, as the assistant message is in omp's session file. */
export function credentialFailureFromMessage(message: unknown): CredentialFailure | null {
  const parsed = ErroredAnswer.safeParse(message);
  if (!parsed.success) return null;
  const answer = parsed.data;
  if (answer.role !== "assistant" || answer.stopReason !== "error") return null;
  // omp retried this attempt and a later one answered: there is no failure to show.
  if (answer.retryRecovery?.status === "recovered") return null;
  const httpStatus = refusedStatus(answer.errorStatus);
  if (httpStatus === undefined) return null;
  return {
    httpStatus,
    provider: words(answer.provider),
    model: words(answer.model),
    text: words(answer.errorMessage) ?? "",
  };
}

/** The failure as a message status carries it: plain JSON, so it survives the transcript. */
export function credentialStatusError(
  failure: CredentialFailure,
): Readonly<Record<string, string | number>> {
  return {
    text: failure.text,
    httpStatus: failure.httpStatus,
    ...(failure.provider === undefined ? {} : { provider: failure.provider }),
    ...(failure.model === undefined ? {} : { model: failure.model }),
  };
}

/** Reads a failure back from a message status; anything else is not a credential failure. */
export function credentialFailureFromStatusError(value: unknown): CredentialFailure | null {
  const parsed = CredentialStatusError.safeParse(value);
  if (!parsed.success) return null;
  const httpStatus = refusedStatus(parsed.data.httpStatus);
  if (httpStatus === undefined) return null;
  return {
    httpStatus,
    provider: words(parsed.data.provider),
    model: words(parsed.data.model),
    text: parsed.data.text,
  };
}
