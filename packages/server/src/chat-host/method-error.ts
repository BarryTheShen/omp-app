import type { ChatHostErrorCode } from "@omp-app/contracts/chat-host";

/**
 * A method's refusal with one of omp's codes the app tells apart (`session_busy`, `unknown_since`, `stale_cursor`).
 * Any other error answers `failed`.
 */
export class HostMethodError extends Error {
  constructor(
    readonly code: ChatHostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HostMethodError";
  }
}
