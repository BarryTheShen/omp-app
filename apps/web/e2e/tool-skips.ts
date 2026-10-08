/**
 * Tools whose card is built by an unmerged part, with that part's issue. The real-omp tool-card tests
 * (`all-tools-real-results.spec.ts` and the own-history test in `tool-cards-real-results.spec.ts`) skip
 * these and report the reason, so they stay honest until those parts merge. Remove a line when its card
 * merges and its real sample is recorded in the module's fixtures.
 */
export const NOT_YET_BUILT: Readonly<Record<string, string>> = {
  ask: "#717 (ask card)",
  web_fetch: "#717 (web_fetch card)",
  vibe_spawn: "#717 (vibe card)",
  recall: "#717 (memory cards)",
  retain: "#717 (memory cards)",
  xd_recall: "#717 (memory cards)",
  xd___recall: "#717 (memory cards)",
  xd__retain: "#717 (memory cards)",
  retain_placeholder: "#717 (memory cards)",
  xd__mcp__notion_search: "#717 (MCP cards)",
  xd__mcp__notion_fetch: "#717 (MCP cards)",
};
