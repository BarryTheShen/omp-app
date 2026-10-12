/** A message that matches a history search: its place among the messages (oldest first), and its text. */
export interface PromptHit {
  readonly index: number;
  readonly text: string;
}

/**
 * The messages that match a history search, newest first. Every word typed must appear in the message, ignoring case,
 * as omp's history search does. With no words typed, every message is listed.
 */
export function searchPrompts(prompts: readonly string[], query: string): PromptHit[] {
  const words = query
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
  const hits: PromptHit[] = [];
  for (let index = prompts.length - 1; index >= 0; index--) {
    const text = prompts[index] ?? "";
    const lower = text.toLocaleLowerCase();
    if (words.every((word) => lower.includes(word))) hits.push({ index, text });
  }
  return hits;
}
