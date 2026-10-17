import { INVENTORY } from "@omp-app/contracts";

/** C1 ids owned by D6, copied from research/modules/D6.md's list, not its stale heading count. */
const D6_C1_IDS = new Set([
  "C1.changelog",
  "C1.changelog-full",
  "C1.debug",
  "C1.jobs",
  "C1.jobs-full",
  "C1.report-panel",
  "C1.security",
  "C1.security-cancel",
  "C1.security-compare",
  "C1.security-disposition",
  "C1.security-export",
  "C1.security-import",
  "C1.security-plan",
  "C1.security-scan",
  "C1.security-scans",
  "C1.security-show",
  "C1.security-status",
  "C1.security-validate",
  "C1.trace",
]);

/** C3 ids owned by D6, including the debug picker listed after the nine-row heading. */
const D6_C3_IDS = new Set([
  "C3.btw",
  "C3.btw-side-panel",
  "C3.cleanse",
  "C3.cleanse-progress-panel",
  "C3.debug-selector",
  "C3.omfg",
  "C3.omfg-rule-panel",
  "C3.pause",
  "C3.pause-gate",
  "C3.pause-screen",
]);

/** The inventory-backed D6 row table used by the CC12 acceptance gate. */
export const D6_OWNED_ROWS = INVENTORY.filter(
  ({ id }) => D6_C1_IDS.has(id) || D6_C3_IDS.has(id),
).map(({ id }) => id);

/** Rows the current inventory marks terminal-only. Issue 1891 changes the btw rows to RPC, so they leave this list; that PR also changes D6.btw and D6.btwCommand requirements after this one merges. */
export const D6_FALLBACK_ROWS = D6_OWNED_ROWS.filter(
  (row) => INVENTORY.find((item) => item.id === row)?.rpc === "terminal-only",
);
