import * as fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { isJsonObject, normalizeHeader, parseTitleSlotLine } from "./parser";
import type { ParseWarning, SessionHeader } from "./types";

const CHUNK_BYTES = 1024 * 1024;

/** A parse warning as a scan records it: the listing adds the file it names. */
export type TranscriptWarning = Omit<ParseWarning, "sessionFile">;

/**
 * What one worker transcript's records say, read once from the file. A listing needs nothing else from a transcript, so
 * the cache keeps these facts rather than the file. How the worker ended also depends on its abort marker, which the
 * listing reads itself (`finalStatusOf` in `subagents.ts`).
 */
export interface TranscriptFacts {
  readonly header?: SessionHeader;
  readonly entryCount: number;
  readonly leafId: string | null;
  readonly agent: string | null;
  /** Whether the transcript holds a successful `yield`, the worker's own report that it finished. */
  readonly sawSuccessfulYield: boolean;
  /** The stop reason of the last assistant message, or null when it records none. */
  readonly assistantStopReason: string | null;
  /** The error text of the last assistant message, or null when it records none. */
  readonly assistantError: string | null;
  /** Whether the last message is an assistant message that stopped normally. */
  readonly endedNormally: boolean;
  readonly warnings: readonly TranscriptWarning[];
}

interface Accumulator {
  header: SessionHeader | undefined;
  logicalIndex: number;
  entryCount: number;
  leafId: string | null;
  agent: string | null;
  sawSuccessfulYield: boolean;
  assistantStopReason: string | null;
  assistantError: string | null;
  endedNormally: boolean;
  warnings: TranscriptWarning[];
}

function warning(
  code: ParseWarning["code"],
  message: string,
  line: number,
  partial = false,
): TranscriptWarning {
  return { code, message, line, ...(partial ? { partial: true } : {}) };
}

function consumeLine(raw: string, lineNumber: number, final: boolean, state: Accumulator): void {
  const line = raw.replace(/\r$/, "");
  if (line.trim().length === 0) return;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    state.warnings.push(
      warning(
        "malformed_line",
        final ? "Incomplete JSONL record" : "Malformed JSONL record",
        lineNumber,
        final,
      ),
    );
    return;
  }
  if (!isJsonObject(value)) return;
  if (lineNumber === 1 && parseTitleSlotLine(line) !== undefined) return;
  if (state.header === undefined && value.type === "session") {
    state.header = normalizeHeader(value);
    if (state.header !== undefined && state.logicalIndex !== 0) {
      state.warnings.push({
        code: "header_not_first",
        message: "Session header was not the first logical record",
        line: lineNumber,
      });
    }
  }
  state.logicalIndex += 1;
  if (value.type === "session") return;
  state.entryCount += 1;
  if (typeof value.id === "string") state.leafId = value.id;
  if (state.agent === null && value.type === "session_init" && typeof value.agent === "string") {
    state.agent = value.agent.length > 0 ? value.agent : null;
  }
  if (value.type !== "message" || !isJsonObject(value.message)) return;
  const message = value.message;
  state.endedNormally = message.role === "assistant" && message.stopReason === "stop";
  if (message.role === "assistant") {
    state.assistantStopReason = typeof message.stopReason === "string" ? message.stopReason : null;
    state.assistantError = typeof message.errorMessage === "string" ? message.errorMessage : null;
  }
  if (
    message.role === "toolResult" &&
    message.toolName === "yield" &&
    message.isError === false &&
    isJsonObject(message.details) &&
    message.details.status === "success"
  ) {
    state.sawSuccessfulYield = true;
  }
}

/**
 * Reads one worker transcript line by line and returns what its records say. `onRead` is called with the byte count of
 * each read. Throws when the file cannot be read.
 */
export async function readTranscriptFacts(
  file: string,
  onRead?: (bytes: number) => void,
): Promise<TranscriptFacts> {
  const state: Accumulator = {
    header: undefined,
    logicalIndex: 0,
    entryCount: 0,
    leafId: null,
    agent: null,
    sawSuccessfulYield: false,
    assistantStopReason: null,
    assistantError: null,
    endedNormally: false,
    warnings: [],
  };
  const handle = await fs.open(file, "r");
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let lineNumber = 0;
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      onRead?.(bytesRead);
      const lines = (carry + decoder.write(buffer.subarray(0, bytesRead))).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        lineNumber += 1;
        consumeLine(line, lineNumber, false, state);
      }
    }
    carry += decoder.end();
    if (carry.length > 0) {
      lineNumber += 1;
      consumeLine(carry, lineNumber, true, state);
    }
  } finally {
    await handle.close();
  }
  if (state.header === undefined) {
    state.warnings.push({ code: "invalid_header", message: "No valid session header found" });
  }
  return {
    ...(state.header === undefined ? {} : { header: state.header }),
    entryCount: state.entryCount,
    leafId: state.leafId,
    agent: state.agent,
    sawSuccessfulYield: state.sawSuccessfulYield,
    assistantStopReason: state.assistantStopReason,
    assistantError: state.assistantError,
    endedNormally: state.endedNormally,
    warnings: state.warnings,
  };
}
