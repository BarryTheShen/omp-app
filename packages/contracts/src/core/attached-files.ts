/**
 * The paragraph a person's message ends with when files are attached to it (#2830). The page uploads each file to the
 * chat's own folder on the server, omp's `local://`, and the message tells omp where it is: the typed text, then this
 * paragraph, one line per file. The composer writes it (`withAttached`), the transcript and the message box read it back
 * (`splitAttached`), and the server leaves it out of a chat's first prompt (`firstPromptTextOf`). All read the constants
 * below, so they cannot drift apart.
 */

/** A file a message names. */
export interface SentFile {
  readonly name: string;
  /** As people read it ("2.4 MB"). */
  readonly size: string;
}

const HEADER = "Attached files (in this chat's local:// folder):";
const LINE = /^- `local:\/\/([^`]+)` \(([^()]+)\)$/;
/** omp decodes a `local://` name (18.12.6 `internal-urls/local-protocol.ts:210-236`): these are written escaped. */
const ESCAPED = new Set(["%", "?", "#", "\\", "`"]);

/** A file's `local://` address as omp reads it: a space as it is, `%` as `%25`, and so on. */
export function localUrl(name: string): string {
  let url = "local://";
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    url += ESCAPED.has(char) || code < 0x20 || code === 0x7f ? encodeURIComponent(char) : char;
  }
  return url;
}

/** The message omp gets: the typed text, then a paragraph naming each file by its address and size. */
export function withAttached(text: string, files: readonly SentFile[]): string {
  if (files.length === 0) return text;
  const lines = files.map((file) => `- \`${localUrl(file.name)}\` (${file.size})`);
  const paragraph = [HEADER, ...lines].join("\n");
  return text === "" ? paragraph : `${text}\n\n${paragraph}`;
}

/** A message read back: its typed text and the files its paragraph names; a message without that paragraph is all text. */
export function splitAttached(message: string): {
  readonly text: string;
  readonly files: readonly SentFile[];
} {
  const whole = { text: message, files: [] };
  const at = message.lastIndexOf(HEADER);
  if (at === -1 || (at > 0 && !message.slice(0, at).endsWith("\n\n"))) return whole;
  const [rest, ...lines] = message.slice(at + HEADER.length).split("\n");
  // The paragraph ends the message; a part joined after it (a picture's empty text) leaves only empty lines.
  while (lines.at(-1) === "") lines.pop();
  if (rest !== "" || lines.length === 0) return whole;
  const files: SentFile[] = [];
  for (const line of lines) {
    const match = LINE.exec(line);
    if (match === null) return whole;
    let name: string;
    try {
      name = decodeURIComponent(match[1] ?? "");
    } catch {
      return whole;
    }
    files.push({ name, size: match[2] ?? "" });
  }
  return { text: at === 0 ? "" : message.slice(0, at - 2), files };
}

/** One line for a message in a list (a queued one): its text, and its files' names. */
export function attachedSummary(message: string): string {
  const { text, files } = splitAttached(message);
  if (files.length === 0) return text;
  const names = files.map((file) => file.name).join(", ");
  return text === "" ? names : `${text} (+ ${names})`;
}
