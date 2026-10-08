/**
 * Tool names with no card of their own, each with the reason. The real-omp tool-card tests
 * (`all-tools-real-results.spec.ts` and the own-history test in `tool-cards-real-results.spec.ts`) skip
 * these and report the reason, so they stay honest. A name whose part has not merged is listed until its
 * card merges and its real sample is recorded in the module's fixtures. The three below are not omp tools:
 * a direct call under them fails as not found and shows on T7's fallback card.
 */
export const NOT_YET_BUILT: Readonly<Record<string, string>> = {
  xd_recall:
    "omp has no tool by this name; a direct call fails as not found and shows on T7's fallback card. Memory calls go through write to xd://recall, which the write card shows",
  xd___recall:
    "omp has no tool by this name; a direct call fails as not found and shows on T7's fallback card. Memory calls go through write to xd://recall, which the write card shows",
  retain_placeholder:
    "omp has no tool by this name; its one recorded call fails as not found and shows on T7's fallback card",
};
