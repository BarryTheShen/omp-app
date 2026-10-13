const ESCAPE = 27;
const TAB = 9;
const NEWLINE = 10;
const DELETE = 127;

/**
 * Makes omp's command output readable as plain text: colour and cursor codes (ESC `[` … final byte) are
 * dropped with the other control characters, so no escape sequence reaches the screen. This only removes
 * terminal syntax; it never reads what the text means.
 */
export function plainOutputText(text: string): string {
  let plain = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === ESCAPE && text.charAt(index + 1) === "[") {
      let end = index + 2;
      // Parameter and intermediate bytes come before the final byte, which is in 0x40–0x7E.
      while (end < text.length && !isFinalByte(text.charCodeAt(end))) end += 1;
      index = end;
      continue;
    }
    if (code === ESCAPE || code === DELETE) continue;
    if (code < 32 && code !== TAB && code !== NEWLINE) continue;
    plain += text.charAt(index);
  }
  return plain.trim();
}

function isFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

/**
 * What the app shows for a finished command, from the texts omp printed for it. A report (text with a line break)
 * keeps every line, in order, for the report panel, which stays until the person closes it. Anything else is one
 * line for the header. The app looks only at line breaks here, never at what the words mean.
 */
export type CommandOutputView =
  | { readonly kind: "report"; readonly text: string }
  | { readonly kind: "header"; readonly text: string };

export function commandOutputView(texts: readonly string[], command: string): CommandOutputView {
  const report = texts
    .map((text) => plainOutputText(text))
    .filter((text) => text !== "")
    .join("\n");
  if (report.includes("\n")) return { kind: "report", text: report };
  return { kind: "header", text: describeOutputs(texts, command) };
}

/**
 * The one line the header shows for the texts omp printed for a command; a command that printed nothing says that it
 * ran. omp's words come through as text, and the app never reads what they mean.
 */
function describeOutputs(texts: readonly string[], command: string): string {
  // The header is one line: every run of spaces and line breaks becomes a single space.
  const oneLine = texts
    .map((text) => plainOutputText(text))
    .join(" ")
    .split(/\s+/u)
    .filter((word) => word !== "")
    .join(" ");
  return oneLine === "" ? `Ran ${command}.` : `omp: ${oneLine}`;
}
