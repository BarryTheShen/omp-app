import { isAbsolute } from "node:path";
import {
  type AbortSignalLike,
  AppFailure,
  SessionImportArgs,
  type SessionImportArgs as SessionImportArgsValue,
  type SessionImportResult as SessionImportResultValue,
} from "@omp-app/contracts";

const IMPORT_CAPABILITY = "upstream.session-import" as const;

function failure(
  code: "invalid_args" | "unavailable" | "cancelled",
  message: string,
  retryable = false,
  capability?: typeof IMPORT_CAPABILITY,
): AppFailure {
  return new AppFailure({ code, message, retryable, ...(capability ? { capability } : {}) });
}

function invalidArgs(message: string): AppFailure {
  return failure("invalid_args", message);
}
function validateArgs(args: SessionImportArgsValue): SessionImportArgsValue {
  const parsed = SessionImportArgs.safeParse(args);
  if (!parsed.success) throw invalidArgs("Session import arguments are invalid.");
  const sourceRef = parsed.data.sourceRef;
  if (sourceRef.includes("\0") || sourceRef.includes("\r") || sourceRef.includes("\n")) {
    throw invalidArgs("The session import reference is invalid.");
  }
  if (parsed.data.sourceKind === "omp-share") {
    let url: URL;
    try {
      url = new URL(sourceRef);
    } catch {
      throw invalidArgs("The omp share reference must be a valid HTTPS URL.");
    }
    if (url.protocol !== "https:") {
      throw invalidArgs("The omp share reference must be a valid HTTPS URL.");
    }
  } else if (!isAbsolute(sourceRef)) {
    throw invalidArgs("The foreign session reference must be an absolute file path.");
  }
  return parsed.data;
}

function unsupportedImport(): AppFailure {
  return failure(
    "unavailable",
    "The running omp does not expose a non-interactive session import operation.",
    false,
    IMPORT_CAPABILITY,
  );
}

/**
 * Creates native omp sessions only through an omp-owned import operation. This service never reads
 * or writes foreign transcripts and never writes native session files. omp 18.12.6 exposes
 * foreign import only through its interactive CLI picker (`--from-claude`, `--from-codex`: `cli/args.ts:347`,
 * `main.ts:874-893,2082`) and has no share-link RPC import, so
 * every validated request receives the explicit upstream capability failure.
 */
export class SessionImportStoreService {
  async import(
    args: SessionImportArgsValue,
    signal?: AbortSignalLike,
  ): Promise<SessionImportResultValue> {
    if (signal?.aborted === true) throw failure("cancelled", "The session import was cancelled.");
    validateArgs(args);
    throw unsupportedImport();
  }
}

export function createSessionImportStore(): SessionImportStoreService {
  return new SessionImportStoreService();
}
