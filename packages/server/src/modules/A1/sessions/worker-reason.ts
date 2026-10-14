/*
 * Why a worker failed, as a typed reason the browser shows (issue 1489). omp keeps the failure on the worker's last
 * assistant message as `errorMessage` (pi-ai 18.6.1 src/types.ts:1165, on AssistantMessage at :1127; omp 18.6.1 pins
 * that pi-ai, package.json:550). The message sits in a session message entry (omp v18.6.1 session-entries.ts:76). For
 * a provider 400, omp saved the rejected request and appended a line to that text: `raw-http-request=<path>`
 * (pi-ai 18.6.1 src/utils/http-inspector.ts:103), or `raw-http-request-save-failed=<reason>` when the save failed
 * (:106). omp's own helper strips those lines before a host relays a provider error, because they carry omp-local
 * paths (:71-80). This module drops them too, wherever they sit. The browser never reads omp's text: it shows the
 * reason returned here.
 */
const REQUEST_LOG_LINE = "raw-http-request=";
const REQUEST_LOG_SAVE_FAILED_LINE = "raw-http-request-save-failed=";

/** The provider's words in omp's failure text, without omp's diagnostics; undefined when no words are left. */
export function workerFailureReason(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isDiagnosticLine(line));
  const reason = foldRepeatedMessage(lines).join(" ");
  return reason === "" ? undefined : reason;
}

function isDiagnosticLine(line: string): boolean {
  return line.startsWith(REQUEST_LOG_LINE) || line.startsWith(REQUEST_LOG_SAVE_FAILED_LINE);
}

/**
 * omp's message is `<status> <message>`, and the provider's error body repeats the message with its type added:
 * `<message> (type=...)`. When the second line starts with the first line's message, the two are one error. This
 * shape was seen in real omp runs; no source line is cited for it (the same rule as U1's `splitProviderError`).
 */
function foldRepeatedMessage(lines: readonly string[]): string[] {
  const [first, second, ...rest] = lines;
  if (first === undefined || second === undefined) return [...lines];
  const message = first.replace(/^\d{3}\s+/, "");
  if (message === "" || !second.startsWith(message)) return [...lines];
  return [`${first}${second.slice(message.length)}`, ...rest];
}
