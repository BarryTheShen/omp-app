import type { AbortSignalLike } from "@omp-app/contracts";
import type { SlashListEntry } from "./rank";

/**
 * A command the app runs itself, such as `/new`. It is named without the slash and takes no arguments; the
 * composition supplies `run`, and D2 never imports the module that does the work.
 */
export interface SlashAppCommand {
  readonly name: string;
  readonly description: string;
  /** Resolves with an optional plain-English note for the header. Rejects with an AppFailure whose message the person sees. */
  readonly run: (options: {
    readonly signal?: AbortSignalLike;
  }) => Promise<{ readonly message?: string }>;
}

export type SlashRoute =
  | { readonly kind: "omp"; readonly command: string }
  | { readonly kind: "app"; readonly command: SlashAppCommand };

/**
 * Decides where a submitted message goes. Only text that starts with the slash, whose first word is a
 * command omp or the app lists, is a command. Anything else, including `/etc/hosts`, an unknown `/word`
 * and text that starts with a space, is a normal prompt and returns null.
 */
export function routeSlashText(
  text: string,
  entries: readonly SlashListEntry[],
  appCommands: readonly SlashAppCommand[],
): SlashRoute | null {
  if (!text.startsWith("/")) return null;
  const trimmed = text.trimEnd();
  for (const app of appCommands) {
    if (trimmed === `/${app.name}`) return { kind: "app", command: app };
  }
  const head = /^\S+/u.exec(trimmed)?.[0] ?? "";
  const name = head.slice(1);
  if (name === "") return null;
  const known = entries.some(
    (entry) => entry.name === name || (entry.aliases ?? []).includes(name),
  );
  return known ? { kind: "omp", command: trimmed } : null;
}
