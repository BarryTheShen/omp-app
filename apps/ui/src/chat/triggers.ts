import { startsWithSecretPlaceholder } from "@omp-app/contracts";
import type { ChatHostCommand } from "@omp-app/contracts/chat-host";

/**
 * How an `@` mention is typed: one word (`@src/pa`), a name in quotes as omp's terminal takes one (`@"lecture 3`, open
 * up to its closing quote), or words with one space between them (`@lecture 3`), which the menu follows while rows
 * match (#2846).
 */
export type MentionForm = "word" | "quoted" | "spaced";

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
      readonly form: MentionForm;
      /** What is searched: the text after `@`, or after `@"`. */
      readonly query: string;
      readonly start: number;
      readonly end: number;
    };

/** `@"` and a name in quotes, open up to the caret (omp's editor: `extractAtFilePrefix`, its quoted prefix). */
const QUOTED = /(?:^|\s)@"([^"\n]*)$/;
/** `@` and one word that does not start with a quote (that is a name in quotes, or one closed already). */
const WORD = /(?:^|\s)@((?:[^\s@"][^\s@]*)?)$/;
/** `@` and words with one space before each after the first; the last may still be empty (`@lecture `). */
const SPACED = /(?:^|\s)@([^\s@"][^\s@]*(?: [^\s@]+)* [^\s@]*)$/;

/**
 * The trigger the caret is in, if any. A `/` command is the box's first word, typed up to the caret with no space yet.
 * An `@` mention starts a word on the caret's line: one word up to the caret; `@"` and a name in quotes, until its
 * closing quote; or words with one space between them (two spaces in a row end it). `start` and `end` are the text a
 * chosen row replaces: the rest of the word under the caret too, and for a name in quotes the rest of it through its
 * closing quote.
 */
export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const command = /^\/(\S*)$/.exec(before);
  if (command !== null) {
    const rest = /^\S*/.exec(text.slice(caret))?.[0] ?? "";
    return { kind: "command", query: command[1] ?? "", start: 0, end: caret + rest.length };
  }
  const line = before.slice(before.lastIndexOf("\n") + 1);
  const after = text.slice(caret);
  const restOfWord = /^\S*/.exec(after)?.[0] ?? "";
  const quoted = QUOTED.exec(line);
  if (quoted !== null) {
    const query = quoted[1] ?? "";
    const rest = /^[^"\n]*"/.exec(after)?.[0] ?? restOfWord;
    const start = caret - query.length - 2;
    return { kind: "file", form: "quoted", query, start, end: caret + rest.length };
  }
  const word = WORD.exec(line);
  const match = word ?? SPACED.exec(line);
  if (match === null) return null;
  const query = match[1] ?? "";
  return {
    kind: "file",
    form: word !== null ? "word" : "spaced",
    query,
    start: caret - query.length - 1,
    end: caret + restOfWord.length,
  };
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

/**
 * A folder mention that keeps the menu in the folder (`path` ends with `/`): `@src/`, or `@"my notes/` with its quote
 * left open when the path needs one, as omp's editor completes a folder (`buildCompletionValue`).
 */
export function folderMention(path: string): string {
  return /[\s"']/.test(path) ? `@"${path.replaceAll('"', '\\"')}` : `@${path}`;
}

/** The message box: its text, and where the caret is. */
export interface BoxState {
  readonly text: string;
  readonly caret: number;
}

/**
 * The box as omp's extensions are asked about a mention: as it is, or for words with spaces their quoted form
 * (`@"lecture 3`, the caret one further), the way omp's terminal gives them a name with spaces.
 */
export function askedAs(text: string, caret: number, trigger: Trigger): BoxState {
  if (trigger.kind !== "file" || trigger.form !== "spaced") return { text, caret };
  const at = trigger.start + 1;
  return { text: `${text.slice(0, at)}"${text.slice(at)}`, caret: caret + 1 };
}

/**
 * An extension's row answered for an earlier keystroke of a mention, put on the box as it is now. The row replaced the
 * mention from `start` up to the caret it was asked at (an extension changes the text before the caret); its insertion
 * now replaces the mention up to the caret, so what was typed since goes too. Null when the row also changed text
 * before `start` or after that caret.
 */
export function rebaseRow(
  row: BoxState,
  asked: BoxState,
  start: number,
  now: BoxState,
): BoxState | null {
  const head = asked.text.slice(0, start);
  const tail = asked.text.slice(asked.caret);
  if (
    row.text.length < head.length + tail.length ||
    !row.text.startsWith(head) ||
    !row.text.endsWith(tail)
  )
    return null;
  const inserted = row.text.slice(start, row.text.length - tail.length);
  const text = now.text.slice(0, start) + inserted + now.text.slice(now.caret);
  return { text, caret: Math.min(row.caret, text.length) };
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
 * `$$`) the run stays out of the model's context. A message that starts with a secret's placeholder ("Add a secret"
 * puts one at the caret, often in an empty box) is a message: the placeholder is not Python.
 */
export interface ShellRun {
  readonly method: "bash" | "python";
  readonly input: string;
  readonly excludeFromContext: boolean;
}

export function shellRun(text: string): ShellRun | null {
  if (startsWithSecretPlaceholder(text)) return null;
  const prefix = ["!!", "$$", "!", "$"].find((candidate) => text.startsWith(candidate));
  if (prefix === undefined) return null;
  return {
    method: prefix.startsWith("!") ? "bash" : "python",
    input: text.slice(prefix.length).trim(),
    excludeFromContext: prefix.length === 2,
  };
}
