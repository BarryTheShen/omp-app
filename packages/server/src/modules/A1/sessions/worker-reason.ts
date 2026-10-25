import type { ProviderErrorResult } from "@omp-app/contracts";

const REQUEST_LOG_LINE = "raw-http-request=";
const REQUEST_LOG_SAVE_FAILED_LINE = "raw-http-request-save-failed=";

/**
 * Separates the provider's error from omp's local request diagnostics. omp v18.12.6 declares these
 * prefixes at `packages/ai/src/utils/http-inspector.ts:63-64`, appends the saved path at :103, and
 * appends the save error at :106. The path is intentionally never returned to the browser.
 */
export function providerErrorDetails(text: string): ProviderErrorResult {
  const messageLines: string[] = [];
  const saveFailureReasons: string[] = [];
  for (const line of text
    .split("\n")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)) {
    if (line.startsWith(REQUEST_LOG_LINE)) continue;
    if (line.startsWith(REQUEST_LOG_SAVE_FAILED_LINE)) {
      const reason = safeSaveFailureReason(line.slice(REQUEST_LOG_SAVE_FAILED_LINE.length));
      if (reason !== undefined) saveFailureReasons.push(reason);
      continue;
    }
    messageLines.push(line);
  }
  const requestLogSaveFailureReason = saveFailureReasons.join("; ");
  return {
    message: foldRepeatedMessage(messageLines).join(" "),
    ...(requestLogSaveFailureReason === "" ? {} : { requestLogSaveFailureReason }),
  };
}

/** The provider-facing words in a worker's last failure; undefined when no words remain. */
export function workerFailureReason(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const { message } = providerErrorDetails(text);
  return message === "" ? undefined : message;
}

function safeSaveFailureReason(text: string): string | undefined {
  const firstClause = text.split(",", 1)[0]?.trim() ?? "";
  const path = /(?:^|\s)(?:[A-Za-z]:[\\/]|\/|\\\\)[^\s]*/.exec(firstClause);
  const reason = (path === null ? firstClause : firstClause.slice(0, path.index))
    .replace(/[,:;\s]+$/, "")
    .trim();
  return reason === "" ? undefined : reason;
}

/**
 * When the second line begins with the first line's message, fold the shared words into one error.
 */
function foldRepeatedMessage(lines: readonly string[]): string[] {
  const [first, second, ...rest] = lines;
  if (first === undefined || second === undefined) return [...lines];
  const message = first.replace(/^\d{3}\s+/, "");
  if (message === "" || !second.startsWith(message)) return [...lines];
  return [`${first}${second.slice(message.length)}`, ...rest];
}
