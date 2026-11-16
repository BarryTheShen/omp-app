/**
 * What search by meaning reads of a chat: the text you and omp wrote (session `message` lines with role user or assistant,
 * their `text` parts), never tool calls or their output, thinking, or omp's own notes, merged into passages of about
 * `PASSAGE_CHARS` characters so a short reply ("ok") is never a passage of its own.
 */

/** A passage's size: long enough to say what a stretch of the chat is about, short for the model (~400 tokens). */
export const PASSAGE_CHARS = 1_500;
/** A message longer than a passage is cut into windows this far apart's overlap, so no sentence is lost at a cut. */
export const OVERLAP_CHARS = 200;

/** The text of one session line, when it is a message you or omp wrote; null for anything else. */
export function messageText(line: string): string | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    typeof entry !== "object" ||
    entry === null ||
    (entry as { type?: unknown }).type !== "message"
  )
    return null;
  const message = (entry as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== "user" && role !== "assistant") return null;
  const parts =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((part: unknown) => {
            const { type, text } = (typeof part === "object" && part !== null ? part : {}) as {
              type?: unknown;
              text?: unknown;
            };
            return type === "text" && typeof text === "string" ? [text] : [];
          })
        : [];
  const text = parts.join("\n").trim();
  return text === "" ? null : text;
}

/** A long text cut into windows of `PASSAGE_CHARS`, each starting `OVERLAP_CHARS` before the last one ended, at a space. */
export function windows(text: string): string[] {
  if (text.length <= PASSAGE_CHARS) return [text];
  const cut: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + PASSAGE_CHARS, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > start + PASSAGE_CHARS / 2) end = space;
    }
    cut.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - OVERLAP_CHARS, start + 1);
  }
  return cut.filter((piece) => piece !== "");
}

/**
 * Messages in order, after the `tail` an earlier read left unfinished, merged into passages: each full passage, and the
 * text after the last one (the new tail, indexed on its own until more comes).
 */
export function passagesOf(
  tail: string,
  messages: readonly string[],
): { passages: string[]; tail: string } {
  const passages: string[] = [];
  let current = tail;
  for (const message of messages) {
    for (const piece of windows(message)) {
      if (current !== "" && current.length + piece.length + 2 > PASSAGE_CHARS) {
        passages.push(current);
        current = "";
      }
      current = current === "" ? piece : `${current}\n\n${piece}`;
    }
    if (current.length >= PASSAGE_CHARS * 0.8) {
      passages.push(current);
      current = "";
    }
  }
  return { passages, tail: current };
}
