import type { AppClient } from "@omp-app/client";
import { AppFailure, AppPort } from "@omp-app/contracts";
import { downloadBytes } from "./panels/files/transfer";

/**
 * Downloads the app's debug log under its own name: the report `omp-app debug-report` writes (versions, what runs, the
 * log's last lines, the page's errors among them). Returns the name.
 */
export async function saveDebugLog(client: AppClient): Promise<string> {
  const report = await client.port(AppPort).debugReport({});
  downloadBytes(new TextEncoder().encode(report.text), report.fileName, "text/plain");
  return report.fileName;
}

/** What a save that worked says. */
export const savedDebugLogText = (fileName: string): string =>
  `Saved ${fileName} to your downloads. Attach it to an issue.`;

/** What a save that failed says: the app's own words (the log is off in this run of the app), or to try again. */
export function debugLogFailureText(failure: unknown): string {
  return failure instanceof AppFailure
    ? failure.appError.message
    : "The debug log could not be saved. Try again.";
}
