import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ScannedSubagent } from "./subagent-scanner";
import { scanSubagentTranscript } from "./subagent-scanner";
import type {
  ParseWarning,
  SessionLeaseState,
  SubagentFinalStatus,
  SubagentTranscript,
} from "./types";

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

/** Whether a live omp holds one worker's own session. `free` means none does, so the worker cannot still be running. */
export type WorkerLeaseProbe = (
  sessionId: string,
  sessionFile: string,
) => Promise<SessionLeaseState>;

/**
 * A worker that records no end is `unknown`, because omp may still be running it. When no live omp holds the worker's
 * own session, nothing runs it: omp was stopped or killed before the worker could record an end, so it is stopped.
 */
async function settledStatus(
  status: SubagentFinalStatus,
  sessionId: string,
  sessionFile: string,
  leaseOf: WorkerLeaseProbe | undefined,
): Promise<SubagentFinalStatus> {
  if (status !== "unknown" || leaseOf === undefined) return status;
  return (await leaseOf(sessionId, sessionFile)) === "free" ? "stopped" : status;
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
  readonly leaseOf: WorkerLeaseProbe | undefined;
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
    const aborted = files.includes(tombstoneName(name));
    const endedAtFiles = [sessionFile, path.join(context.root, tombstoneName(name))];
    let scanned: ScannedSubagent;
    try {
      scanned = await scanSubagentTranscript(sessionFile, aborted, null);
    } catch {
      context.warnings.push({
        code: "subagent_read_error",
        message: "Unable to read subagent transcript",
        sessionFile,
      });
      continue;
    }
    if (scanned.header !== undefined) {
      const status = await settledStatus(
        scanned.status,
        scanned.header.id,
        sessionFile,
        context.leaseOf,
      );
      const endedAt = status === "unknown" ? null : await lastWrittenAt(endedAtFiles);
      const transcript: SubagentTranscript = {
        key,
        agentId,
        parent: context.parentKey,
        sessionFile,
        path: sessionFile,
        id: scanned.header.id,
        header: scanned.header,
        entryCount: scanned.entryCount,
        leafId: scanned.leafId,
        aborted,
        status,
        endedAt,
        agent: scanned.agent,
        ...(scanned.reason === undefined ? {} : { reason: scanned.reason }),
        parseWarnings: scanned.parseWarnings,
      };
      context.output.push(transcript);
      context.warnings.push(...scanned.parseWarnings);
    } else {
      context.warnings.push(...scanned.parseWarnings);
    }

    if (childDirectories.has(agentId)) {
      await walkSubagentDirectory({
        root: path.join(context.root, agentId),
        parentKey: key,
        output: context.output,
        warnings: context.warnings,
        leaseOf: context.leaseOf,
      });
    }
  }
}

/**
 * Discover nested `<session-stem>/<AgentId>.jsonl` transcripts. Advisor files,
 * backups and symlinked directories are excluded exactly as omp's collector
 * does; tombstones remain visible as `aborted` metadata.
 * With `leaseOf`, a worker that records no end is stopped once no live omp holds its own session.
 */
export async function collectSubagentTranscripts(
  sessionFile: string,
  leaseOf?: WorkerLeaseProbe,
): Promise<SubagentCollection> {
  if (!sessionFile.endsWith(".jsonl")) return { subagents: [], parseWarnings: [] };
  const output: SubagentTranscript[] = [];
  const warnings: ParseWarning[] = [];
  await walkSubagentDirectory({
    root: sessionFile.slice(0, -".jsonl".length),
    parentKey: null,
    output,
    warnings,
    leaseOf,
  });
  return { subagents: output, parseWarnings: warnings };
}
