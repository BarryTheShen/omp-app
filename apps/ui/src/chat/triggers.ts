import type { ChatHostCommand } from "@omp-app/contracts/chat-host";

/** What the text at the caret asks for: one of omp's `/` commands, or a file to mention with `@`. */
export type Trigger =
  | {
      readonly kind: "command";
      readonly query: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "file";
      readonly query: string;
      readonly start: number;
      readonly end: number;
    };

/**
 * The trigger the caret is in, if any. A `/` command is the box's first word, typed up to the caret with no space yet;
 * an `@` mention starts a word anywhere and runs to the caret. `start` and `end` are the text a chosen row replaces.
 */
export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const command = /^\/(\S*)$/.exec(before);
  if (command !== null) {
    const rest = /^\S*/.exec(text.slice(caret))?.[0] ?? "";
    return { kind: "command", query: command[1] ?? "", start: 0, end: caret + rest.length };
  }
  const mention = /(^|\s)@([^\s@]*)$/.exec(before);
  if (mention !== null) {
    const start = caret - (mention[2] ?? "").length - 1;
    const rest = /^\S*/.exec(text.slice(caret))?.[0] ?? "";
    return { kind: "file", query: mention[2] ?? "", start, end: caret + rest.length };
  }
  return null;
}

/** omp's commands whose name or alias holds the query, those that start with it first. */
export function matchCommands(
  commands: readonly ChatHostCommand[],
  query: string,
): readonly ChatHostCommand[] {
  const wanted = query.toLowerCase();
  const names = (command: ChatHostCommand) => [command.name, ...(command.aliases ?? [])];
  const starts = commands.filter((command) =>
    names(command).some((name) => name.toLowerCase().startsWith(wanted)),
  );
  const contains = commands.filter(
    (command) =>
      !starts.includes(command) &&
      names(command).some((name) => name.toLowerCase().includes(wanted)),
  );
  return [...starts, ...contains];
}

/** A file mention as omp reads it: `@path`, quoted when the path holds a space or a quote, then a space. */
export function mentionText(path: string): string {
  return /[\s"']/.test(path) ? `@"${path.replaceAll('"', '\\"')}" ` : `@${path} `;
}

/** The text with a trigger's span replaced, and where the caret goes. */
export function replaceTrigger(
  text: string,
  trigger: Trigger,
  replacement: string,
): { readonly text: string; readonly caret: number } {
  return {
    text: text.slice(0, trigger.start) + replacement + text.slice(trigger.end),
    caret: trigger.start + replacement.length,
  };
}

/**
 * omp's shell prefixes: `!` runs a command in bash and `$` code in Python, both recorded in the chat; doubled (`!!`,
 * `$$`) the run stays out of the model's context.
 */
export interface ShellRun {
  readonly method: "bash" | "python";
  readonly input: string;
  readonly excludeFromContext: boolean;
}

export function shellRun(text: string): ShellRun | null {
  const prefix = ["!!", "$$", "!", "$"].find((candidate) => text.startsWith(candidate));
  if (prefix === undefined) return null;
  return {
    method: prefix.startsWith("!") ? "bash" : "python",
    input: text.slice(prefix.length).trim(),
    excludeFromContext: prefix.length === 2,
  };
}
