import * as fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { isJsonObject, normalizeHeader, parseTitleSlotLine } from "./parser";
import type { ParseWarning, SessionHeader, SubagentFinalStatus } from "./types";
import { workerFailureReason } from "./worker-reason";

const CHUNK_BYTES = 1024 * 1024;

const cache = new Map<
  string,
  {
    readonly size: number;
    readonly mtimeMs: number;
    readonly result: Omit<ScannedSubagent, "endedAt">;
  }
>();
export interface ScannedSubagent {
  readonly header?: SessionHeader;
  readonly entryCount: number;
  readonly leafId: string | null;
  readonly aborted: boolean;
  readonly status: SubagentFinalStatus;
  readonly endedAt: string | null;
  readonly agent: string | null;
  readonly reason?: string;
  readonly parseWarnings: readonly ParseWarning[];
}

interface Accumulator {
  header: SessionHeader | undefined;
  logicalIndex: number;
  entryCount: number;
  leafId: string | null;
  agent: string | null;
  sawSuccessfulYield: boolean;
  lastAssistantStopReason: unknown;
  lastAssistantErrorMessage: unknown;
  lastMessageRole: unknown;
  lastMessageStopReason: unknown;
  warnings: ParseWarning[];
}

function warning(
  code: ParseWarning["code"],
  message: string,
  line: number,
  file: string,
  partial = false,
): ParseWarning {
  return { code, message, line, sessionFile: file, ...(partial ? { partial: true } : {}) };
}

function consumeLine(
  raw: string,
  lineNumber: number,
  final: boolean,
  file: string,
  state: Accumulator,
): void {
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
        file,
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
        sessionFile: file,
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
  state.lastMessageRole = message.role;
  state.lastMessageStopReason = message.stopReason;
  if (message.role === "assistant") {
    state.lastAssistantStopReason = message.stopReason;
    state.lastAssistantErrorMessage = message.errorMessage;
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

function statusOf(state: Accumulator, aborted: boolean): SubagentFinalStatus {
  if (state.sawSuccessfulYield) return "completed";
  if (state.lastAssistantStopReason === "error") return "failed";
  if (aborted || state.lastAssistantStopReason === "aborted") return "aborted";
  if (state.lastMessageRole === "assistant" && state.lastMessageStopReason === "stop")
    return "stopped";
  return "unknown";
}

export async function scanSubagentTranscript(
  file: string,
  aborted: boolean,
  endedAt: string | null,
): Promise<ScannedSubagent> {
  const info = await fs.stat(file);
  const cached = cache.get(file);
  if (
    cached !== undefined &&
    cached.size === info.size &&
    cached.mtimeMs === info.mtimeMs &&
    cached.result.aborted === aborted
  ) {
    return { ...cached.result, endedAt };
  }
  const state: Accumulator = {
    header: undefined,
    logicalIndex: 0,
    entryCount: 0,
    leafId: null,
    agent: null,
    sawSuccessfulYield: false,
    lastAssistantStopReason: undefined,
    lastAssistantErrorMessage: undefined,
    lastMessageRole: undefined,
    lastMessageStopReason: undefined,
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
      const lines = (carry + decoder.write(buffer.subarray(0, bytesRead))).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        lineNumber += 1;
        consumeLine(line, lineNumber, false, file, state);
      }
    }
    carry += decoder.end();
    if (carry.length > 0) {
      lineNumber += 1;
      consumeLine(carry, lineNumber, true, file, state);
    }
  } finally {
    await handle.close();
  }
  if (state.header === undefined) {
    state.warnings.push({
      code: "invalid_header",
      message: "No valid session header found",
      sessionFile: file,
    });
  }
  const status = statusOf(state, aborted);
  const reason =
    status === "failed"
      ? workerFailureReason(
          typeof state.lastAssistantErrorMessage === "string"
            ? state.lastAssistantErrorMessage
            : undefined,
        )
      : undefined;
  const result: Omit<ScannedSubagent, "endedAt"> = {
    ...(state.header === undefined ? {} : { header: state.header }),
    entryCount: state.entryCount,
    leafId: state.leafId,
    aborted,
    status,
    agent: state.agent,
    ...(reason === undefined ? {} : { reason }),
    parseWarnings: state.warnings,
  };
  cache.set(file, { size: info.size, mtimeMs: info.mtimeMs, result });
  while (cache.size > 2000) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return { ...result, endedAt };
}
