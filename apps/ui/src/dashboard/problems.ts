export const failureText = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/** What a call says when the server is older than the dashboard's part: an unknown port, or an unknown method. */
const OLD_SERVER = /Unknown (method|port)/;

/**
 * The words for a call that failed: `later` when the server is older than the part ("Rules come with the next server
 * update."), else "Could not `action`: " and the server's own words.
 */
export function problemWords(failure: unknown, later: string, action: string): string {
  const text = failureText(failure);
  return OLD_SERVER.test(text) ? later : `Could not ${action}: ${text}`;
}
