import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isJsonObject, parseSessionContent } from "./parser";
import type { ParseWarning, SubagentFinalStatus, SubagentTranscript } from "./types";

function isAdvisorTranscriptName(name: string): boolean {
  return name === "__advisor.jsonl" || (name.startsWith("__advisor.") && name.endsWith(".jsonl"));
}

function tombstoneName(transcriptName: string): string {
  return `${transcriptName}.tombstone`;
}

/** A file the collector walks as a transcript: a `.jsonl` that is neither a backup nor an advisor. */
export function isCollectedTranscriptName(name: string): boolean {
  return name.endsWith(".jsonl") && !name.includes(".bak") && !isAdvisorTranscriptName(name);
}

/** The agent type omp records in a worker's `session_init` record; null when there is none. */
function agentOf(entries: readonly unknown[]): string | null {
  for (const entry of entries) {
    if (isJsonObject(entry) && entry.type === "session_init" && typeof entry.agent === "string") {
      return entry.agent.length > 0 ? entry.agent : null;
    }
  }
  return null;
}

/** The message a `message` record carries; undefined for any other record. */
function messageOf(entry: unknown): Record<string, unknown> | undefined {
  if (!isJsonObject(entry) || entry.type !== "message") return undefined;
  return isJsonObject(entry.message) ? entry.message : undefined;
}

/** A `yield` result that finished its worker: omp records it as a success and not as an error. */
function isSuccessfulYield(entry: unknown): boolean {
  const message = messageOf(entry);
  if (message?.role !== "toolResult" || message.toolName !== "yield" || message.isError !== false) {
    return false;
  }
  return isJsonObject(message.details) && message.details.status === "success";
}

/**
 * How a worker ended, from its own records. A successful `yield` completed it. Otherwise the last
 * assistant turn decides: omp records `error` and `aborted` stop reasons there, and a tombstone marks
 * a worker omp cancelled. A worker that records none of these is `unknown`, including one that exits
 * without `yield`: omp reports that verdict in its run result, and this reader only reads the file.
 */
function finalStatusOf(entries: readonly unknown[], aborted: boolean): SubagentFinalStatus {
  if (entries.some(isSuccessfulYield)) return "completed";
  let lastAssistant: Record<string, unknown> | undefined;
  for (const entry of entries) {
    const message = messageOf(entry);
    if (message?.role === "assistant") lastAssistant = message;
  }
  if (lastAssistant?.stopReason === "error") return "failed";
  if (aborted || lastAssistant?.stopReason === "aborted") return "aborted";
  return "unknown";
}

/** The newest modification time among the files that exist, as an ISO string; null when none does. */
async function lastWrittenAt(files: readonly string[]): Promise<string | null> {
  let newest = 0;
  for (const file of files) {
    try {
      newest = Math.max(newest, (await fs.stat(file)).mtimeMs);
    } catch {
      // A file that is not there, such as an abort marker, has no time to contribute.
    }
  }
  return newest === 0 ? null : new Date(newest).toISOString();
}

export interface SubagentCollection {
  readonly subagents: readonly SubagentTranscript[];
  readonly parseWarnings: readonly ParseWarning[];
}

interface WalkContext {
  readonly root: string;
  readonly parentKey: string | null;
  readonly output: SubagentTranscript[];
  readonly warnings: ParseWarning[];
}

async function walkSubagentDirectory(context: WalkContext): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(context.root, { withFileTypes: true });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    context.warnings.push({
      code: "subagent_read_error",
      message: "Unable to read subagent directory",
      sessionFile: context.root,
    });
    return;
  }

  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const childDirectories = new Set(
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  );

  for (const name of files) {
    if (!isCollectedTranscriptName(name)) continue;
    const agentId = name.slice(0, -".jsonl".length);
    const key = context.parentKey ? `${context.parentKey}/${agentId}` : agentId;
    const sessionFile = path.join(context.root, name);
    let content: string;
    try {
      content = await fs.readFile(sessionFile, "utf8");
    } catch {
      context.warnings.push({
        code: "subagent_read_error",
        message: "Unable to read subagent transcript",
        sessionFile,
      });
      continue;
    }

    const parsed = parseSessionContent(content, sessionFile);
    if (parsed.header) {
      const entriesWithoutHeader = parsed.entries.filter((entry) => {
        return !(isJsonObject(entry) && entry.type === "session");
      });
      const leafEntry = [...entriesWithoutHeader].reverse().find((entry) => {
        return isJsonObject(entry) && typeof entry.id === "string";
      });
      const aborted = files.includes(tombstoneName(name));
      const status = finalStatusOf(entriesWithoutHeader, aborted);
      const transcript: SubagentTranscript = {
        key,
        agentId,
        parent: context.parentKey,
        sessionFile,
        path: sessionFile,
        id: parsed.header.id,
        header: parsed.header,
        entries: entriesWithoutHeader,
        leafId:
          leafEntry && isJsonObject(leafEntry) && typeof leafEntry.id === "string"
            ? leafEntry.id
            : null,
        aborted,
        status,
        endedAt:
          status === "unknown"
            ? null
            : await lastWrittenAt([sessionFile, path.join(context.root, tombstoneName(name))]),
        agent: agentOf(entriesWithoutHeader),
        parseWarnings: parsed.parseWarnings,
      };
      context.output.push(transcript);
      context.warnings.push(...parsed.parseWarnings);
    } else if (parsed.parseWarnings.length > 0) {
      context.warnings.push(...parsed.parseWarnings);
    }

    if (childDirectories.has(agentId)) {
      await walkSubagentDirectory({
        root: path.join(context.root, agentId),
        parentKey: key,
        output: context.output,
        warnings: context.warnings,
      });
    }
  }
}

/**
 * Discover nested `<session-stem>/<AgentId>.jsonl` transcripts. Advisor files,
 * backups and symlinked directories are excluded exactly as omp's collector
 * does; tombstones remain visible as `aborted` metadata.
 */
export async function collectSubagentTranscripts(sessionFile: string): Promise<SubagentCollection> {
  if (!sessionFile.endsWith(".jsonl")) return { subagents: [], parseWarnings: [] };
  const output: SubagentTranscript[] = [];
  const warnings: ParseWarning[] = [];
  await walkSubagentDirectory({
    root: sessionFile.slice(0, -".jsonl".length),
    parentKey: null,
    output,
    warnings,
  });
  return { subagents: output, parseWarnings: warnings };
}
