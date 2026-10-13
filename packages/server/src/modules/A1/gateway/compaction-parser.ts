/**
 * omp's words for a `/compact` that finished in the background (omp 18.8.9, `slash-commands/builtin-lifecycle.ts`):
 * a failure prints "Compaction failed: <reason>" (line 243), and a saved compaction prints "Compaction complete.",
 * with its token counts on line 250, after omp has written the entry. Any other text is not a result: it gives
 * undefined. Only the server reads these words; the browser gets the outcome.
 */
const SAVED = "Compaction complete.";
const FAILED = "Compaction failed: ";

export function compactionOutcome(text: string): "saved" | "failed" | undefined {
  if (text.startsWith(SAVED)) return "saved";
  if (text.startsWith(FAILED)) return "failed";
  return undefined;
}
