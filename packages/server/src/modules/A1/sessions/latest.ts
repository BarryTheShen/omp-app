/** The fields of a listed chat that omp's rule for an empty chat reads. */
export interface ContinueCandidate {
  readonly status?: string | undefined;
  readonly assistantTurns: number;
  readonly title?: string | null | undefined;
  readonly firstPrompt?: string | null | undefined;
}

/**
 * The chat omp's `--continue` opens in a folder: the newest one with resumable content. omp passes over an empty chat
 * (its `isEmptySession`: no settled status, no assistant turn, no name and no first message), so the server can find
 * the same chat before omp starts. The listing is newest first, as the store returns it.
 */
export function newestContinuableChat<T extends ContinueCandidate>(
  sessions: readonly T[],
): T | undefined {
  return sessions.find((session) => !isEmptyChat(session));
}

function isEmptyChat(session: ContinueCandidate): boolean {
  if (
    session.status !== undefined &&
    session.status !== "pending" &&
    session.status !== "unknown"
  ) {
    return false;
  }
  if (session.assistantTurns > 0) return false;
  if (hasText(session.title)) return false;
  // omp's label for a chat with no messages is not a first message.
  return !hasText(session.firstPrompt === "(no messages)" ? undefined : session.firstPrompt);
}

/** omp's sanitizeSessionName drops blank names; a blank name or first message counts as none. */
function hasText(value: string | null | undefined): boolean {
  return (value ?? "").trim() !== "";
}
