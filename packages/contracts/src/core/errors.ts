/**
 * The one error shape every port method, envelope `result` and fixture check uses.
 */
import { z } from "zod";
import { CapabilityKey } from "./capabilities";

export const APP_ERROR_CODES = [
  /** The capability is missing in this omp, host or client (see `capability`). */
  "unavailable",
  /** Arguments failed the method's schema or a precondition. */
  "invalid_args",
  /** omp answered with a failure (`success: false`, or a `prompt_result` error); see `omp`. */
  "omp_error",
  /** The omp process exited or its stdio closed before answering. */
  "omp_exited",
  "timeout",
  "cancelled",
  /** The state changed underneath the call (stale cursor, busy session, concurrent write). */
  "conflict",
  "not_found",
  "permission",
  /** A bug in the app; never a user-facing condition. */
  "internal",
] as const;

export const AppErrorCode = z.enum(APP_ERROR_CODES);
export type AppErrorCode = z.infer<typeof AppErrorCode>;

/**
 * What omp reported, copied from the failed response (`command`, `error`, `code`) or from a
 * `prompt_result` error (`provider`, `model`, `httpStatus`).
 */
export const OmpErrorDetail = z.object({
  command: z.string().optional(),
  error: z.string(),
  code: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  httpStatus: z.int().optional(),
});
export type OmpErrorDetail = z.infer<typeof OmpErrorDetail>;

export const AppError = z.object({
  code: AppErrorCode,
  /** Human-readable; never contains secrets or unscrubbed home paths. */
  message: z.string(),
  /** Retrying the same call later may succeed. */
  retryable: z.boolean(),
  /** The capability whose absence caused an `unavailable` error. */
  capability: CapabilityKey.optional(),
  omp: OmpErrorDetail.optional(),
});
export type AppError = z.infer<typeof AppError>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: AppError };

/**
 * Parses JSON text and validates it against a schema. Failures come back as `invalid_args`
 * errors instead of being thrown; the message names the failing fields but never echoes the
 * input, which may hold secrets.
 */
export function parseJson<T>(schema: z.ZodType<T>, text: string): ParseResult<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: { code: "invalid_args", message: "Not valid JSON", retryable: false },
    };
  }
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  const message = z.prettifyError(result.error);
  return { ok: false, error: { code: "invalid_args", message, retryable: false } };
}
