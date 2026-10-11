import type { Page } from "@playwright/test";

/**
 * Words a person should never read in the execution-mode controls: the app's own names, and omp's internal ones.
 * omp's reply after "Sent to omp." is not scanned (see `appWrittenText`): omp words its replies itself.
 */
export const INTERNAL_WORDS =
  /RPC|gateway|capabilit|fallback|baseline|tier|command|prelude|slash|session|conversation|typed|probe|policy|detail|configured|flex|execution-mode|standard path|\/[a-z]/i;

/**
 * The controls' text with omp's own reply left out: what the app wrote, as a person reads it. A status that starts
 * with "Sent to omp." keeps that prefix only.
 */
export async function appWrittenText(page: Page): Promise<string> {
  return page.locator("[data-d7-mode-controls]").evaluate((root) => {
    const copy = root.cloneNode(true) as HTMLElement;
    for (const status of copy.querySelectorAll('[role="status"]')) {
      if ((status.textContent ?? "").startsWith("Sent to omp."))
        status.textContent = "Sent to omp.";
    }
    return copy.textContent ?? "";
  });
}
