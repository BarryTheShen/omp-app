import type { StartupReason } from "@omp-app/contracts";

/**
 * Why omp stopped before a chat was ready, from its last stderr words. The server reads omp's
 * wording here, once, and sends the browser the typed reason, so the browser never matches omp's prose.
 * omp 18.12.6 prints "No default model selected. ..." and exits with code 1 when no model or key is set up
 * (`sdk.ts:3418`, `main.ts:2617-2647`).
 */
export function startupReason(stderrTail: string): StartupReason {
  if (/No default model selected|No models available|No model selected/.test(stderrTail)) {
    return "no_model";
  }
  if (/No API key/.test(stderrTail)) return "no_credentials";
  return "other";
}
