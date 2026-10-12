/**
 * omp appends its own diagnostics to a provider error it saved a rejected request for: a line
 * `raw-http-request=<path>`, or `raw-http-request-save-failed=<reason>` when the save failed. The
 * installed omp build (18.8.9) has both strings in `packages/ai/src/utils/http-inspector.ts`, in
 * `appendRawHttpRequestDumpFor400`; the omp v18.6.1 reference tree has neither. Those lines are not
 * the provider's words, so they are shown behind "Show details", never in the sentence.
 */
const REQUEST_LOG_LINE = "raw-http-request=";
const REQUEST_LOG_SAVE_FAILED_LINE = "raw-http-request-save-failed=";

interface ProviderErrorText {
  /** The provider's words, once: omp's message with a repeated first line folded into one. */
  readonly reason: string;
  /** Where the rejected request was saved, or why it was not; shown only behind "Show details". */
  readonly details: string | undefined;
}

/**
 * Splits omp's error text into the sentence and the diagnostics. The installed omp build (18.8.9)
 * joins the provider's message and the provider's error body with a newline, and the body repeats
 * the message with `(type=...)` added. When the second line starts with the first line's message,
 * the two are read as one error: `400 <message> (type=...)`. This shape was seen in real omp runs;
 * no source line is cited for it.
 */
export function splitProviderError(text: string): ProviderErrorText {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const messageLines: string[] = [];
  const details: string[] = [];
  for (const line of lines) {
    if (line.startsWith(REQUEST_LOG_LINE)) {
      details.push(`Request log: ${line.slice(REQUEST_LOG_LINE.length)}`);
    } else if (line.startsWith(REQUEST_LOG_SAVE_FAILED_LINE)) {
      details.push(
        `The request log could not be saved: ${line.slice(REQUEST_LOG_SAVE_FAILED_LINE.length)}`,
      );
    } else {
      messageLines.push(line);
    }
  }
  return {
    reason: foldRepeatedMessage(messageLines).join(" "),
    details: details.length === 0 ? undefined : details.join("\n"),
  };
}

function foldRepeatedMessage(lines: readonly string[]): string[] {
  const [first, second, ...rest] = lines;
  if (first === undefined || second === undefined) return [...lines];
  // The first line is omp's `<status> <message>`; the body line repeats `<message>` and adds its type.
  const message = first.replace(/^\d{3}\s+/, "");
  if (message === "" || !second.startsWith(message)) return [...lines];
  return [`${first}${second.slice(message.length)}`, ...rest];
}
