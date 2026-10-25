import type { DiagnosticCommandRequest } from "../contract";

/**
 * `/changelog` with no arguments shows the three most recent releases; `full` shows the whole
 * changelog (omp v18.12.6 utils/changelog.ts:18 and :38, `RECENT_CHANGELOG_ENTRY_LIMIT`).
 */
export type ChangelogView = "recent" | "full";

/**
 * `/jobs` lists background jobs, or their full command lines with `full`
 * (research/omp-feature-inventory.md:562-563; research/modules/D6.md:38).
 */
export type JobsView = "summary" | "full";

export function changelogRequest(view: ChangelogView): DiagnosticCommandRequest {
  return view === "full" ? { name: "changelog", args: "full" } : { name: "changelog" };
}

export function jobsRequest(view: JobsView): DiagnosticCommandRequest {
  return view === "full" ? { name: "jobs", args: "full" } : { name: "jobs" };
}

/**
 * `/trace` starts omp's stats dashboard on this computer and returns this session's trace URL,
 * which carries the session file's path (omp v18.12.6 slash-commands/builtin-collaboration.ts:204-220).
 */
export const TRACE_REQUEST: DiagnosticCommandRequest = { name: "trace" };
