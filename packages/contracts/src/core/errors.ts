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
  /** omp is still running a turn, so a new prompt was refused. The browser offers to queue it or to interrupt it. */
  "agent_busy",
  "not_found",
  /** omp cannot restore a chat's saved model; the message says which, and a model can be picked to open the chat. */
  "model_unavailable",
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

/** Why omp stopped before a chat could start, read from its last words: no model, no sign-in, or another reason. */
export const StartupReason = z.enum(["no_model", "no_credentials", "other"]);
export type StartupReason = z.infer<typeof StartupReason>;

/** Why a `conflict` has a reason of its own: `held_elsewhere` is another omp (a terminal's) holding the chat's lease. */
const ConflictReason = z.enum(["held_elsewhere"]);

export const AppError = z.object({
  code: AppErrorCode,
  /** Human-readable; never contains secrets or unscrubbed home paths. */
  message: z.string(),
  /** Retrying the same call later may succeed. */
  retryable: z.boolean(),
  /** The capability whose absence caused an `unavailable` error. */
  capability: CapabilityKey.optional(),
  omp: OmpErrorDetail.optional(),
  /** Set when omp stopped before a New chat was ready: the typed reason (see `StartupReason`). */
  startup: StartupReason.optional(),
  /** Set on a `conflict` with its reason (see `ConflictReason`): another omp holds the chat, so the open was refused. */
  conflictReason: ConflictReason.optional(),
});
export type AppError = z.infer<typeof AppError>;

/**
 * The one way to throw an AppError (contract change 2026-10-05). Server handlers and stores throw
 * it; A0's dispatcher sends its `appError` in the `result` frame; the client rejects a failed call
 * with it, so every layer catches the same type and reads `appError.code`. Anything else that is
 * thrown is reported as `internal`.
 */
export class AppFailure extends Error {
  readonly appError: AppError;

  constructor(appError: AppError, options?: { cause?: unknown }) {
    super(appError.message, options);
    this.name = "AppFailure";
    this.appError = appError;
  }
}

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
