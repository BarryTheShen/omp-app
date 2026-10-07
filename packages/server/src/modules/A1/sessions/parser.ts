import type {
  ParsedSession,
  ParseWarning,
  SessionEntry,
  SessionHeader,
  SessionTitleSlot,
  SessionTitleSource,
} from "./types";

const KNOWN_ENTRY_TYPES: Record<string, true> = {
  session: true,
  message: true,
  model_usage: true,
  thinking_level_change: true,
  model_change: true,
  service_tier_change: true,
  compaction: true,
  branch_summary: true,
  custom: true,
  custom_message: true,
  label: true,
  title_change: true,
  ttsr_injection: true,
  session_init: true,
  mode_change: true,
  credential_pin: true,
  reset_boundary: true,
};

/** The one JSON-object guard used at this persisted-data boundary. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTitleSource(value: unknown): value is SessionTitleSource {
  return value === "auto" || value === "user";
}

/** Parse omp's fixed-width physical first-line title slot. */
export function parseTitleSlotLine(line: string): SessionTitleSlot | undefined {
  try {
    const value: unknown = JSON.parse(line.replace(/\r$/, ""));
    if (!isJsonObject(value) || value.type !== "title" || value.v !== 1) return undefined;
    if (
      typeof value.title !== "string" ||
      typeof value.updatedAt !== "string" ||
      typeof value.pad !== "string" ||
      (value.source !== undefined && !isTitleSource(value.source))
    ) {
      return undefined;
    }
    const slot: SessionTitleSlot = {
      type: "title",
      v: 1,
      title: value.title,
      updatedAt: value.updatedAt,
      pad: value.pad,
    };
    return value.source === undefined ? slot : { ...slot, source: value.source };
  } catch {
    return undefined;
  }
}

/** Parse a title slot only when it is the first physical line. */
export function parseTitleSlotFromContent(content: string): SessionTitleSlot | undefined {
  const newline = content.indexOf("\n");
  if (newline < 0) return undefined;
  return parseTitleSlotLine(content.slice(0, newline));
}

export function normalizeHeader(value: Record<string, unknown>): SessionHeader | undefined {
  if (value.type !== "session" || typeof value.id !== "string" || value.id.length === 0)
    return undefined;
  const header: Record<string, unknown> = { ...value, type: "session", id: value.id };
  if (typeof value.version !== "number" || !Number.isInteger(value.version)) delete header.version;
  if (typeof value.cwd !== "string") header.cwd = "";
  if (typeof value.title !== "string") delete header.title;
  if (!isTitleSource(value.titleSource)) delete header.titleSource;
  if (typeof value.timestamp !== "string") delete header.timestamp;
  if (typeof value.parentSession !== "string") delete header.parentSession;
  return header as SessionHeader;
}

function warning(
  code: ParseWarning["code"],
  message: string,
  line: number | undefined,
  sessionFile: string | undefined,
  partial = false,
): ParseWarning {
  const result: {
    code: ParseWarning["code"];
    message: string;
    line?: number;
    sessionFile?: string;
    partial?: boolean;
  } = { code, message };
  if (line !== undefined) result.line = line;
  if (sessionFile !== undefined) result.sessionFile = sessionFile;
  if (partial) result.partial = true;
  return result;
}

/**
 * Parse a physical omp session body line-by-line. A bad or incomplete line is
 * retained as a warning while every subsequent complete JSON record remains
 * available to callers. Unknown record types are intentionally accepted.
 */
export function parseSessionContent(content: string, sessionFile?: string): ParsedSession {
  const lines = content.split("\n");
  const hasTrailingNewline = content.endsWith("\n");
  const titleSlot = parseTitleSlotFromContent(content);
  const entries: unknown[] = [];
  const parseWarnings: ParseWarning[] = [];
  const unknownEntryTypes: string[] = [];
  let malformedRecords = 0;
  let partialLine = false;
  let header: SessionHeader | undefined;
  let headerIndex = -1;
  const firstLogicalLine = titleSlot ? 1 : 0;

  for (let index = firstLogicalLine; index < lines.length; index++) {
    const line = lines[index]?.replace(/\r$/, "") ?? "";
    if (line.trim().length === 0) continue;
    const isFinalPhysicalLine = index === lines.length - 1 && !hasTrailingNewline;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformedRecords++;
      partialLine ||= isFinalPhysicalLine;
      parseWarnings.push(
        warning(
          "malformed_line",
          isFinalPhysicalLine ? "Incomplete JSONL record" : "Malformed JSONL record",
          index + 1,
          sessionFile,
          isFinalPhysicalLine,
        ),
      );
      continue;
    }

    entries.push(value);
    if (isJsonObject(value) && typeof value.type === "string" && !KNOWN_ENTRY_TYPES[value.type]) {
      if (!unknownEntryTypes.includes(value.type)) unknownEntryTypes.push(value.type);
    }
    if (header === undefined && isJsonObject(value) && value.type === "session") {
      header = normalizeHeader(value);
      if (header) {
        headerIndex = entries.length - 1;
        if (headerIndex !== 0) {
          parseWarnings.push(
            warning(
              "header_not_first",
              "Session header was not the first logical record",
              index + 1,
              sessionFile,
            ),
          );
        }
      }
    }
  }

  if (header === undefined) {
    parseWarnings.push(
      warning("invalid_header", "No valid session header found", undefined, sessionFile),
    );
  }

  if (titleSlot && header) {
    const title = titleSlot.title;
    const headerWithTitle = { ...header };
    if (title.length > 0) headerWithTitle.title = title;
    else delete headerWithTitle.title;
    if (titleSlot.source) headerWithTitle.titleSource = titleSlot.source;
    else delete headerWithTitle.titleSource;
    header = headerWithTitle;
    if (headerIndex >= 0) entries[headerIndex] = headerWithTitle;
  }

  return {
    header,
    titleSlot,
    entries,
    malformedRecords,
    partialLine,
    unknownEntryTypes,
    parseWarnings,
  };
}

/** A narrow record guard for callers walking unknown logical entries. */
export function isSessionEntry(value: unknown): value is SessionEntry {
  return isJsonObject(value);
}
