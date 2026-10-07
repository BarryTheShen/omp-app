import type { OmpWire } from "@omp-app/contracts";

export interface CacheMissSummary {
  readonly reprocessedTokens: number;
}

/** Finds only a warm-to-cold transition that explicitly rebuilds the provider's prompt cache. */
export function cacheMissBetween(
  previous: OmpWire.Usage | null,
  current: OmpWire.Usage,
): CacheMissSummary | null {
  if (
    previous === null ||
    !Number.isFinite(previous.cacheRead) ||
    previous.cacheRead <= 0 ||
    !Number.isFinite(current.cacheRead) ||
    current.cacheRead !== 0 ||
    !Number.isFinite(current.cacheWrite) ||
    current.cacheWrite <= 0 ||
    !Number.isFinite(current.input) ||
    current.input < 0
  ) {
    return null;
  }

  const reprocessedTokens = current.cacheWrite + current.input;
  return reprocessedTokens > 0 ? { reprocessedTokens } : null;
}

export function formatTokenCount(tokens: number): string {
  return tokens.toLocaleString();
}

export function compactionMethodLabel(method: string | undefined): string {
  switch (method) {
    case "remote":
      return "Conversation compacted remotely";
    case "handoff":
      return "Conversation summarized for a handoff";
    case "snapcompact":
      return "Conversation compacted with a detailed summary";
    case "shake":
      return "Conversation summary refreshed";
    default:
      return "Conversation compacted";
  }
}
