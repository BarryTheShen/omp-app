import { type AbortSignalLike, AppFailure } from "@omp-app/contracts";
import type { SlashListEntry } from "./rank";

/**
 * A command the app runs itself, such as `/new`. It is named without the slash; the composition supplies `run`, and D2
 * never imports the module that does the work. A bare name runs it with no arguments. A command that sets
 * `takesArguments` also runs when text follows its name, and `run` then gets that text as `args`.
 */
export interface SlashAppCommand {
  readonly name: string;
  readonly description: string;
  /** Set for a command that reads the text after its name (`/goal ship the release`). Without it, `/name text` is not the app's. */
  readonly takesArguments?: true;
  /** Resolves with an optional plain-English note for the header. Rejects with an AppFailure whose message the person sees. */
  readonly run: (options: {
    readonly signal?: AbortSignalLike;
    /** The text after the name, trimmed. Given only when the command takes arguments and some were typed. */
    readonly args?: string;
  }) => Promise<{ readonly message?: string }>;
}

export type SlashRoute =
  | { readonly kind: "omp"; readonly command: string }
  | { readonly kind: "app"; readonly command: SlashAppCommand; readonly args?: string };

/**
 * omp commands the app answers itself in every form, because omp runs them the moment they are sent, whatever
 * follows the name: `/share` uploads the whole chat to omp's share server with no question asked
 * (builtin-collaboration.ts:284-309, export/share.ts:492-517). So `/share`, `/share <anything>`, `/share:<anything>`,
 * any letter case and leading spaces are the app's, and none of them reaches omp unanswered.
 */
const GUARDED_OMP_COMMANDS: Record<string, true> = { share: true };

/** The guarded command a message names, in lower case, or null. omp reads the name up to a space or a colon. */
export function guardedCommandName(text: string): string | null {
  const name = /^\s*\/([^\s:]+)/u.exec(text)?.[1]?.toLowerCase();
  return name !== undefined && GUARDED_OMP_COMMANDS[name] === true ? name : null;
}

/** The refusal for a guarded form the app has no handler for. Nothing is sent to omp. */
export function guardedRefusal(name: string): AppFailure {
  return new AppFailure({
    code: "unavailable",
    message: `/${name} isn't available in this app, so nothing was sent to omp.`,
    retryable: false,
  });
}

/**
 * The app's route for a guarded form, or null when the text is not one. The app's own command of that name
 * answers it; with none, the form is refused, so omp still never sees it.
 */
export function guardedRoute(
  text: string,
  appCommands: readonly SlashAppCommand[],
): SlashRoute | null {
  const name = guardedCommandName(text);
  if (name === null) return null;
  const own = appCommands.find((command) => command.name.toLowerCase() === name);
  if (own !== undefined) return { kind: "app", command: own };
  return {
    kind: "app",
    command: {
      name,
      description: "Not available in this app",
      run: () => Promise.reject(guardedRefusal(name)),
    },
  };
}

/**
 * Decides where a submitted message goes. Only text that starts with the slash, whose first word is a
 * command omp or the app lists, is a command. Anything else, including `/etc/hosts`, an unknown `/word`
 * and text that starts with a space, is a normal prompt and returns null. A guarded form (see
 * GUARDED_OMP_COMMANDS) is a command whatever follows it, and leading spaces do not hide it.
 */
export function routeSlashText(
  text: string,
  entries: readonly SlashListEntry[],
  appCommands: readonly SlashAppCommand[],
): SlashRoute | null {
  const guarded = guardedRoute(text, appCommands);
  if (guarded !== null) return guarded;
  if (!text.startsWith("/")) return null;
  const trimmed = text.trimEnd();
  for (const app of appCommands) {
    if (trimmed === `/${app.name}`) return { kind: "app", command: app };
  }
  const head = /^\S+/u.exec(trimmed)?.[0] ?? "";
  // A command that takes arguments is the app's when text follows its name. The bare name is matched above, unchanged.
  for (const app of appCommands) {
    if (app.takesArguments === true && head === `/${app.name}`) {
      return { kind: "app", command: app, args: trimmed.slice(head.length).trim() };
    }
  }
  const name = head.slice(1);
  if (name === "") return null;
  const known = entries.some(
    (entry) => entry.name === name || (entry.aliases ?? []).includes(name),
  );
  return known ? { kind: "omp", command: trimmed } : null;
}
