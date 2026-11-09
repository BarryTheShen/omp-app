/**
 * What the tools decide without VS Code, so they are checked without it: which path a call names, how an edit changes a
 * file, and how lines, matches and long output are given back.
 */
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

/** A file or folder of the project, as a call names it: its absolute path, and its path relative to the project. */
export interface ProjectPath {
  readonly absolute: string;
  readonly relative: string;
}

/**
 * The path a call names, inside the project's folder `root`: a relative path, or an absolute one inside the folder.
 * Anything else (outside the folder, `..` that leaves it, an empty path) throws a sentence for the model.
 */
export function projectPath(root: string, asked: unknown, what = "path"): ProjectPath {
  if (typeof asked !== "string" || asked.trim() === "")
    throw new Error(`Say which file: "${what}" is a path relative to the project's folder.`);
  const text = asked.trim().replace(/^\.\/+/, "");
  const absolute = normalize(isAbsolute(text) ? text : resolve(root, text));
  const inside = relative(root, absolute);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new Error(`${asked} is outside the project's folder; this chat works only in it.`);
  return { absolute, relative: inside === "" ? "." : inside.split(sep).join("/") };
}

/** Whether a real path (links followed) is inside the project's real folder. */
export function insideRealRoot(realRoot: string, realPath: string): boolean {
  const inside = relative(realRoot, realPath);
  return inside === "" || !(inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside));
}

/** How many times `part` occurs in `text`, not overlapping. */
export function occurrences(text: string, part: string): number {
  if (part === "") return 0;
  let count = 0;
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + part.length))
    count += 1;
  return count;
}

/** The file's new text after an edit, or the reason the edit cannot be made. */
export function editedText(
  text: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
  path: string,
): string {
  if (oldText === "") throw new Error("old_text is empty: say which text to replace.");
  if (oldText === newText)
    throw new Error("old_text and new_text are the same: nothing would change.");
  const count = occurrences(text, oldText);
  if (count === 0)
    throw new Error(
      `old_text is not in ${path}. Read the file again with vscode_read and copy the text exactly, without the line numbers.`,
    );
  if (count > 1 && !replaceAll)
    throw new Error(
      `old_text occurs ${count} times in ${path}: give more of the text around it so it occurs once, or set replace_all.`,
    );
  return replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
}

/** The most lines one read gives back, and the most characters. */
export const READ_MAX_LINES = 2_000;
export const READ_MAX_CHARS = 200_000;

/** A file's lines, numbered from 1, as `vscode_read` gives them back: one range, within the limits. */
export function numberedLines(text: string, startLine?: number, endLine?: number): string {
  if (text === "") return "(The file is empty.)";
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n")) lines.pop();
  const total = lines.length;
  const first = Math.max(1, Math.min(startLine ?? 1, total));
  const asked = Math.min(endLine ?? total, total);
  if (asked < first) throw new Error(`end_line ${asked} comes before start_line ${first}.`);
  const out: string[] = [];
  let chars = 0;
  let last = first - 1;
  for (let line = first; line <= asked && line - first < READ_MAX_LINES; line++) {
    const shown = `${line}\t${lines[line - 1]}`;
    if (chars + shown.length > READ_MAX_CHARS) break;
    out.push(shown);
    chars += shown.length + 1;
    last = line;
  }
  if (last < total)
    out.push(`(Lines ${first}-${last} of ${total}; ask for start_line ${last + 1} to read on.)`);
  return out.join("\n");
}

/** A search's pattern, from its query: a regular expression, or plain text taken as it is. */
export function searchPattern(query: string, literal: boolean, caseSensitive: boolean): RegExp {
  const source = literal ? query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : query;
  try {
    return new RegExp(source, caseSensitive ? "" : "i");
  } catch (error) {
    throw new Error(
      `"${query}" is not a regular expression (${error instanceof Error ? error.message : String(error)}); set literal for plain text.`,
    );
  }
}

/** One file's matches as `path:line: text`, each line cut to 300 characters. */
export function matchLines(path: string, text: string, pattern: RegExp, room: number): string[] {
  const found: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length && found.length < room; index++) {
    const line = lines[index] ?? "";
    if (!pattern.test(line)) continue;
    const shown = line.length > 300 ? `${line.slice(0, 300)}…` : line;
    found.push(`${path}:${index + 1}: ${shown.trim()}`);
  }
  return found;
}

/** The most output a command gives back: its start and its end, with the middle cut out. */
export const OUTPUT_HEAD = 20_000;
export const OUTPUT_TAIL = 60_000;

/**
 * A command's output as it comes, kept within the limits: its first `OUTPUT_HEAD` characters and its last
 * `OUTPUT_TAIL`, and how many were cut between them.
 */
export class KeptOutput {
  #head = "";
  #tail = "";
  #total = 0;

  add(part: string): void {
    this.#total += part.length;
    let rest = part;
    if (this.#head.length < OUTPUT_HEAD) {
      const room = OUTPUT_HEAD - this.#head.length;
      this.#head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (rest !== "") this.#tail = (this.#tail + rest).slice(-OUTPUT_TAIL);
  }

  /** Whole when nothing was cut; else the start and the end, with the count of what was cut between. */
  text(): string {
    const cut = this.#total - this.#head.length - this.#tail.length;
    return cut > 0
      ? `${this.#head}\n… (${cut} characters cut) …\n${this.#tail}`
      : `${this.#head}${this.#tail}`;
  }
}
