import * as fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { firstPromptTextOf, MESSAGE_PART_SEPARATOR } from "@omp-app/contracts";
import { isJsonObject, normalizeHeader, parseTitleSlotLine } from "./parser";
import type { ParseWarning, SessionHeader, SessionStatus, SessionTitleSlot } from "./types";

/**
 * What a session list needs from a file, found in one pass that keeps only counters: a session file
 * can be tens of megabytes (the largest in one real store is 44 MB), and reading and parsing every
 * file whole on each listing used to take more than 5 GB of memory for a 252 MB folder.
 */
export interface SessionSummary {
  /** The first session header, with the title slot folded in as `parseSessionContent` does. */
  readonly header: SessionHeader | undefined;
  readonly messageCount: number;
  readonly assistantTurns: number;
  readonly firstPrompt: string | null;
  readonly status: SessionStatus;
  readonly parseWarnings: readonly ParseWarning[];
}

/** Bytes per read of a session file: the scanner reads a file in pieces of this size. */
export const CHUNK_BYTES = 256 * 1024;
const FIRST_PROMPT_MAX = 120;
/** The header sits in the first lines; this is far more than they need (the title slot is 256 bytes). */
const HEADER_SCAN_BYTES = 256 * 1024;

/**
 * A user message's first prompt as one line of at most FIRST_PROMPT_MAX characters; null when empty. The typed text is
 * listed. A message that is only a pasted text lists that text's first line. omp's wrapper is never listed
 * (`firstPromptTextOf`).
 */
export function promptLine(content: unknown): string | null {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              isJsonObject(part) && part.type === "text" && typeof part.text === "string"
                ? part.text
                : "",
            )
            .join(MESSAGE_PART_SEPARATOR)
        : "";
  const line = firstPromptTextOf(text).replace(/\s+/g, " ").trim();
  if (line.length === 0) return null;
  return line.length > FIRST_PROMPT_MAX ? `${line.slice(0, FIRST_PROMPT_MAX - 1)}…` : line;
}

/** The status a single message entry implies; the file's status is the last message's. */
function statusOfMessage(message: Record<string, unknown>): SessionStatus {
  switch (message.role) {
    case "assistant": {
      if (message.stopReason === "error") return "error";
      if (message.stopReason === "aborted") return "aborted";
      if (message.stopReason === "length") return "interrupted";
      if (
        Array.isArray(message.content) &&
        message.content.some((part) => isJsonObject(part) && part.type === "toolCall")
      ) {
        return "interrupted";
      }
      return "complete";
    }
    case "toolResult":
      return "interrupted";
    case "user":
      return "pending";
    default:
      return "unknown";
  }
}

function warn(
  code: ParseWarning["code"],
  message: string,
  line: number | undefined,
  sessionFile: string,
  partial = false,
): ParseWarning {
  return {
    code,
    message,
    ...(line === undefined ? {} : { line }),
    sessionFile,
    ...(partial ? { partial: true } : {}),
  };
}

/**
 * Applies `parseSessionContent`'s rules to one physical line at a time, keeping counters instead of
 * records. `summary.test.ts` holds the two implementations to the same answers.
 */
class SessionScanner {
  readonly #sessionFile: string;
  readonly #warnings: ParseWarning[] = [];
  #lineIndex = 0;
  #entryCount = 0;
  #titleSlot: SessionTitleSlot | undefined;
  #header: SessionHeader | undefined;
  #messageCount = 0;
  #assistantTurns = 0;
  #firstPrompt: string | null = null;
  #status: SessionStatus = "unknown";

  constructor(sessionFile: string) {
    this.#sessionFile = sessionFile;
  }

  /** A physical line that ended with a newline. */
  line(raw: string): void {
    const index = this.#lineIndex++;
    if (index === 0) {
      const slot = parseTitleSlotLine(raw);
      if (slot) {
        this.#titleSlot = slot;
        return;
      }
    }
    this.#logical(raw, index, false);
  }

  /** The text after the last newline: empty for a file that ends with one, else the final line. */
  finish(rest: string): void {
    if (rest.length > 0) this.#logical(rest, this.#lineIndex++, true);
    if (this.#header === undefined) {
      this.#warnings.push(
        warn("invalid_header", "No valid session header found", undefined, this.#sessionFile),
      );
    }
  }

  summary(): SessionSummary {
    let header = this.#header;
    if (this.#titleSlot && header) {
      const folded: Record<string, unknown> = { ...header };
      if (this.#titleSlot.title.length > 0) folded.title = this.#titleSlot.title;
      else delete folded.title;
      if (this.#titleSlot.source) folded.titleSource = this.#titleSlot.source;
      else delete folded.titleSource;
      header = folded as SessionHeader;
    }
    return {
      header,
      messageCount: this.#messageCount,
      assistantTurns: this.#assistantTurns,
      firstPrompt: this.#firstPrompt,
      status: this.#status,
      parseWarnings: this.#warnings,
    };
  }

  #logical(raw: string, index: number, isFinalWithoutNewline: boolean): void {
    const line = raw.replace(/\r$/, "");
    if (line.trim().length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#warnings.push(
        warn(
          "malformed_line",
          isFinalWithoutNewline ? "Incomplete JSONL record" : "Malformed JSONL record",
          index + 1,
          this.#sessionFile,
          isFinalWithoutNewline,
        ),
      );
      return;
    }
    const entryIndex = this.#entryCount++;
    if (!isJsonObject(value)) return;
    if (this.#header === undefined && value.type === "session") {
      this.#header = normalizeHeader(value);
      if (this.#header && entryIndex !== 0) {
        this.#warnings.push(
          warn(
            "header_not_first",
            "Session header was not the first logical record",
            index + 1,
            this.#sessionFile,
          ),
        );
      }
    }
    if (value.type !== "message") return;
    this.#messageCount++;
    const message = value.message;
    if (!isJsonObject(message)) return;
    this.#status = statusOfMessage(message);
    if (message.role === "assistant") this.#assistantTurns++;
    if (this.#firstPrompt === null && message.role === "user") {
      this.#firstPrompt = promptLine(message.content);
    }
  }
}

/**
 * Reads a session file in CHUNK_BYTES pieces and returns its summary. Memory stays near the size of the longest single
 * line; the file is never held whole. Throws the file system's error if it can't be opened or read.
 *
 * A long line's pieces are joined once, when its newline arrives: the carried text was re-split on every read, which
 * copied a long line once per read. Each read gets a buffer of its own: on a 30-chat first page, one reused buffer let
 * the decoded text of long lines wait for the collector, and the peak resident size was about a third higher (measured
 * with `summary-cache-memory.test.ts`).
 */
export async function summarizeSessionFile(sessionFile: string): Promise<SessionSummary> {
  const handle = await fs.open(sessionFile, "r");
  try {
    const scanner = new SessionScanner(sessionFile);
    const decoder = new StringDecoder("utf8");
    let pieces: string[] = [];
    for (;;) {
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      const text = decoder.write(buffer.subarray(0, bytesRead));
      let from = 0;
      let newline = text.indexOf("\n");
      while (newline !== -1) {
        pieces.push(text.slice(from, newline));
        scanner.line(pieces.length === 1 ? (pieces[0] ?? "") : pieces.join(""));
        pieces = [];
        from = newline + 1;
        newline = text.indexOf("\n", from);
      }
      if (from < text.length) pieces.push(text.slice(from));
    }
    scanner.finish(pieces.join("") + decoder.end());
    return scanner.summary();
  } finally {
    await handle.close();
  }
}

/**
 * The session header only, from the start of the file: how a folder's working directory is found
 * without summarizing any session.
 */
export async function readSessionHeader(sessionFile: string): Promise<SessionHeader | undefined> {
  const handle = await fs.open(sessionFile, "r");
  try {
    const buffer = Buffer.allocUnsafe(HEADER_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_SCAN_BYTES, 0);
    const lines = new StringDecoder("utf8").write(buffer.subarray(0, bytesRead)).split("\n");
    // The last piece may be cut mid-line by the scan limit: never trust it unless it ended the file.
    if (bytesRead === HEADER_SCAN_BYTES) lines.pop();
    let slot: SessionTitleSlot | undefined;
    let header: SessionHeader | undefined;
    for (const [index, raw] of lines.entries()) {
      const line = raw.replace(/\r$/, "");
      if (index === 0) {
        slot = parseTitleSlotLine(line);
        if (slot) continue;
      }
      if (line.trim().length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (isJsonObject(value) && value.type === "session") {
        header = normalizeHeader(value);
        if (header) break;
      }
    }
    if (header && slot) {
      const folded: Record<string, unknown> = { ...header };
      if (slot.title.length > 0) folded.title = slot.title;
      else delete folded.title;
      return folded as SessionHeader;
    }
    return header;
  } finally {
    await handle.close();
  }
}
