import type { Rule } from "@omp-app/contracts";

/** Synthetic, scrubbed A1.15 values using omp-native Markdown rule names. */
export const I3_RULES = [
  {
    id: "review-notes.md",
    name: "Review notes",
    scope: "global",
    content: "Keep review notes concise and actionable.",
    enabled: true,
    source: "agent",
    revision: "rules-revision-1",
  },
  {
    id: "project-style.mdc",
    name: "Project style",
    scope: "project",
    content: "Reuse the repository's established style.",
    enabled: false,
    source: "project",
    revision: "rules-revision-1",
  },
] as const satisfies readonly Rule[];
