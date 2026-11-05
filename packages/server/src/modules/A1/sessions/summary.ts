import * as fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { firstPromptTextOf, MESSAGE_PART_SEPARATOR } from "@omp-app/contracts";
import { isJsonObject, normalizeHeader, parseTitleSlotLine } from "./parser";
import type {
  ParseWarning,
  SessionHeader,
  SessionStatus,
  SessionTitleSlot,
  SessionTitleSource,
} from "./types";

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
            // The texts alone: a picture's place is no part, so nothing trails the last text.
            .flatMap((part) =>
              isJsonObject(part) && part.type === "text" && typeof part.text === "string"
                ? [part.text]
                : [],
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

/** A parse warning without its path: the path is the key of the cached facts that hold it. */
function withoutPath(warning: ParseWarning): Omit<ParseWarning, "sessionFile"> {
  return {
    code: warning.code,
    message: warning.message,
    ...(warning.line === undefined ? {} : { line: warning.line }),
    ...(warning.partial === undefined ? {} : { partial: warning.partial }),
  };
}

/**
 * Everything a summary keeps of the lines it has read, as plain data, so that a later read can carry on from it. The
 * title slot's padding is left out: a summary never reads it.
 */
export interface SummaryFoldState {
  /** Physical lines fed so far, the title slot included. */
  readonly lineIndex: number;
  /** Logical records parsed so far. */
  readonly entryCount: number;
  readonly titleSlot?: {
    readonly title: string;
    readonly source?: SessionTitleSource;
    readonly updatedAt: string;
  };
  readonly header?: Readonly<Record<string, unknown>>;
  readonly messageCount: number;
  readonly assistantTurns: number;
  readonly firstPrompt: string | null;
  readonly status: SessionStatus;
  readonly warnings: Omit<ParseWarning, "sessionFile">[];
}

/** One summary pass over a session file, fed one physical line at a time. */
export interface SummaryFold {
  /** Feeds one complete physical line, without its newline. */
  push(raw: string): void;
  /**
   * The summary of the lines pushed so far, with `rest` (the text after the last newline) read as a last record the way a
   * file's end is read. Changes nothing: the fold can go on from where it was.
   */
  result(rest?: string): SessionSummary;
  /** The state after the lines pushed so far, for `summaryFoldFrom`. */
  state(): SummaryFoldState;
}

/**
 * Applies `parseSessionContent`'s rules to one physical line at a time, keeping counters instead of records.
 * `summary.test.ts` holds the two implementations to the same answers.
 */
class SessionFold implements SummaryFold {
  readonly #sessionFile: string;
  #warnings: ParseWarning[];
  #lineIndex: number;
  #entryCount: number;
  #titleSlot: SessionTitleSlot | undefined;
  #header: SessionHeader | undefined;
  #messageCount: number;
  #assistantTurns: number;
  #firstPrompt: string | null;
  #status: SessionStatus;

  constructor(sessionFile: string, state?: SummaryFoldState) {
    this.#sessionFile = sessionFile;
    this.#warnings = (state?.warnings ?? []).map((warning) => ({ ...warning, sessionFile }));
    this.#lineIndex = state?.lineIndex ?? 0;
    this.#entryCount = state?.entryCount ?? 0;
    this.#titleSlot =
      state?.titleSlot === undefined
        ? undefined
        : {
            type: "title",
            v: 1,
            title: state.titleSlot.title,
            ...(state.titleSlot.source === undefined ? {} : { source: state.titleSlot.source }),
            updatedAt: state.titleSlot.updatedAt,
            pad: "",
          };
    this.#header = state?.header === undefined ? undefined : (state.header as SessionHeader);
    this.#messageCount = state?.messageCount ?? 0;
    this.#assistantTurns = state?.assistantTurns ?? 0;
    this.#firstPrompt = state?.firstPrompt ?? null;
    this.#status = state?.status ?? "unknown";
  }

  push(raw: string): void {
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

  result(rest = ""): SessionSummary {
    const view = new SessionFold(this.#sessionFile, this.state());
    if (rest.length > 0) view.#logical(rest, view.#lineIndex++, true);
    if (view.#header === undefined) {
      view.#warnings.push(
        warn("invalid_header", "No valid session header found", undefined, this.#sessionFile),
      );
    }
    return view.#summary();
  }

  state(): SummaryFoldState {
    return {
      lineIndex: this.#lineIndex,
      entryCount: this.#entryCount,
      ...(this.#titleSlot === undefined
        ? {}
        : {
            titleSlot: {
              title: this.#titleSlot.title,
              ...(this.#titleSlot.source === undefined ? {} : { source: this.#titleSlot.source }),
              updatedAt: this.#titleSlot.updatedAt,
            },
          }),
      ...(this.#header === undefined ? {} : { header: { ...this.#header } }),
      messageCount: this.#messageCount,
      assistantTurns: this.#assistantTurns,
      firstPrompt: this.#firstPrompt,
      status: this.#status,
      warnings: this.#warnings.map(withoutPath),
    };
  }

  #summary(): SessionSummary {
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

/** A summary over `sessionFile` from its first line. */
export function createSummaryFold(sessionFile: string): SummaryFold {
  return new SessionFold(sessionFile);
}

/** A summary over `sessionFile` that goes on from `state`, the state of an earlier fold over the same lines. */
export function summaryFoldFrom(sessionFile: string, state: SummaryFoldState): SummaryFold {
  return new SessionFold(sessionFile, state);
}

/**
 * Where a fold read stopped: `offset` is the byte offset after the last complete line that was fed, and `rest` is the text
 * from there to the end of the read (a line without its newline yet, possibly empty).
 */
export interface FoldRead {
  readonly offset: number;
  readonly rest: string;
}

/**
 * Feeds the complete lines of bytes [from, until) of `sessionFile` to `fold`, in CHUNK_BYTES pieces. Only whole lines are
 * fed: the text after the last newline is returned as `rest`, and `offset` is where it starts. A line is split on the
 * newline byte, which never occurs inside a UTF-8 character, so each line decodes whole. Memory stays near the size of the
 * longest line.
 */
export async function foldSessionFile(
  sessionFile: string,
  fold: SummaryFold,
  from = 0,
  until = Number.POSITIVE_INFINITY,
): Promise<FoldRead> {
  const handle = await fs.open(sessionFile, "r");
  try {
    let position = from;
    let lineStart = from;
    // A line's pieces are joined as strings, the way the streaming reader always joined them. Joining Buffers instead kept
    // each long line's bytes outside the JS heap, where the collector runs less often, and the first page of 30 chats peaked
    // about 40 MiB higher (summary-cache-memory.test.ts). A newline byte never occurs inside a UTF-8 character, so each line's
    // decoder is ended at its newline and the next line starts clean.
    const decoder = new StringDecoder("utf8");
    let text = "";
    while (position < until) {
      const want = Math.min(CHUNK_BYTES, until - position);
      const buffer = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(buffer, 0, want, position);
      if (bytesRead === 0) break;
      const chunkStart = position;
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;
      let newline = chunk.indexOf(0x0a);
      while (newline !== -1) {
        text += decoder.write(chunk.subarray(start, newline));
        text += decoder.end();
        fold.push(text);
        text = "";
        start = newline + 1;
        lineStart = chunkStart + start;
        newline = chunk.indexOf(0x0a, start);
      }
      if (start < chunk.length) text += decoder.write(chunk.subarray(start));
    }
    return { offset: lineStart, rest: text + decoder.end() };
  } finally {
    await handle.close();
  }
}

/**
 * Reads a session file in CHUNK_BYTES pieces and returns its summary. Memory stays near the size of the longest single
 * line; the file is never held whole. Throws the file system's error if it can't be opened or read.
 */
export async function summarizeSessionFile(sessionFile: string): Promise<SessionSummary> {
  const fold = createSummaryFold(sessionFile);
  const read = await foldSessionFile(sessionFile, fold);
  return fold.result(read.rest);
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
