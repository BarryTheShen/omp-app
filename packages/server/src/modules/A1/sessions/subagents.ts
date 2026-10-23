import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scanRecordedOutcomes } from "./recorded-outcomes";
import { type SubagentScanCache, sharedSubagentScanCache } from "./subagent-cache";
import { readTranscriptFacts, type TranscriptFacts } from "./subagent-scanner";
import type {
  ParseWarning,
  RecordedWorkerStatus,
  SessionLeaseState,
  SubagentFinalStatus,
  SubagentTranscript,
} from "./types";
import { workerFailureReason } from "./worker-reason";

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

/**
 * How a worker ended: its own records decide, and its abort marker decides when they say nothing. A transcript that
 * records no end is `unknown` here; `settledStatus` may make it `stopped`.
 */
function finalStatusOf(facts: TranscriptFacts, aborted: boolean): SubagentFinalStatus {
  if (facts.sawSuccessfulYield) return "completed";
  if (facts.assistantStopReason === "error") return "failed";
  if (aborted || facts.assistantStopReason === "aborted") return "aborted";
  if (facts.endedNormally) return "stopped";
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
  readonly leaseOf: WorkerLeaseProbe | undefined;
  readonly cache: SubagentScanCache;
}

/** A path's real path, or undefined when it cannot be read. */
async function realpathOf(file: string): Promise<string | undefined> {
  try {
    return await fs.realpath(file);
  } catch {
    return undefined;
  }
}

/**
 * The outcomes a parent session records for its workers. The scan resumes where the cache's last scan of that parent
 * ended. A parent that is missing or unreadable records none.
 */
async function outcomesOf(
  parentFile: string,
  cache: SubagentScanCache,
): Promise<ReadonlyMap<string, RecordedWorkerStatus>> {
  const key = await realpathOf(parentFile);
  if (key === undefined) return new Map();
  const state = await scanRecordedOutcomes(parentFile, cache.parent(key), {
    onRead: (bytes) => cache.onRead?.(parentFile, bytes),
  });
  if (state === undefined) {
    cache.forgetParent(key);
    return new Map();
  }
  cache.putParent(key, state);
  return state.outcomes;
}

/**
 * A transcript's facts: from the cache while the file keeps the identity it was read with, else read again. Throws when
 * the file cannot be read.
 */
async function factsOf(
  cache: SubagentScanCache,
  realFile: string,
  sessionFile: string,
): Promise<TranscriptFacts> {
  const info = await fs.stat(sessionFile);
  const identity = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
  const known = cache.transcript(realFile, identity);
  if (known !== undefined) return known;
  const facts = await readTranscriptFacts(sessionFile, (bytes) =>
    cache.onRead?.(sessionFile, bytes),
  );
  cache.putTranscript(realFile, identity, facts);
  return facts;
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
  if (!files.some(isCollectedTranscriptName)) return;
  const childDirectories = new Set(
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  );
  // A transcript's cache key is its real path: this folder's real path joined with the file's name.
  const realRoot = await realpathOf(context.root);
  if (realRoot === undefined) {
    context.warnings.push({
      code: "subagent_read_error",
      message: "Unable to read subagent directory",
      sessionFile: context.root,
    });
    return;
  }
  const outcomes = await outcomesOf(`${context.root}.jsonl`, context.cache);

  for (const name of files) {
    if (!isCollectedTranscriptName(name)) continue;
    const agentId = name.slice(0, -".jsonl".length);
    const key = context.parentKey ? `${context.parentKey}/${agentId}` : agentId;
    const sessionFile = path.join(context.root, name);
    let facts: TranscriptFacts;
    try {
      facts = await factsOf(context.cache, path.join(realRoot, name), sessionFile);
    } catch {
      context.warnings.push({
        code: "subagent_read_error",
        message: "Unable to read subagent transcript",
        sessionFile,
      });
      continue;
    }
    const transcriptWarnings: ParseWarning[] = facts.warnings.map((item) => ({
      ...item,
      sessionFile,
    }));
    if (facts.header !== undefined) {
      const aborted = files.includes(tombstoneName(name));
      const recordedStatus = outcomes.get(agentId);
      const ended = finalStatusOf(facts, aborted);
      const status = await settledStatus(ended, facts.header.id, sessionFile, context.leaseOf);
      const endedAt =
        status === "unknown" && recordedStatus === undefined
          ? null
          : await lastWrittenAt([sessionFile, path.join(context.root, tombstoneName(name))]);
      const reason =
        ended === "failed" ? workerFailureReason(facts.assistantError ?? undefined) : undefined;
      context.output.push({
        key,
        agentId,
        parent: context.parentKey,
        sessionFile,
        path: sessionFile,
        id: facts.header.id,
        header: facts.header,
        entryCount: facts.entryCount,
        leafId: facts.leafId,
        aborted,
        status,
        endedAt,
        agent: facts.agent,
        ...(reason === undefined ? {} : { reason }),
        ...(recordedStatus === undefined ? {} : { recordedStatus }),
        parseWarnings: transcriptWarnings,
      });
    }
    context.warnings.push(...transcriptWarnings);

    if (childDirectories.has(agentId)) {
      await walkSubagentDirectory({
        root: path.join(context.root, agentId),
        parentKey: key,
        output: context.output,
        warnings: context.warnings,
        leaseOf: context.leaseOf,
        cache: context.cache,
      });
    }
  }
}

/**
 * Discover nested `<session-stem>/<AgentId>.jsonl` transcripts. Advisor files,
 * backups and symlinked directories are excluded exactly as omp's collector
 * does; tombstones remain visible as `aborted` metadata.
 * With `leaseOf`, a worker that records no end is stopped once no live omp holds its own session.
 * `cache` keeps each transcript's facts and each parent's outcomes between calls; without one, the process's shared
 * in-memory cache is used.
 */
export async function collectSubagentTranscripts(
  sessionFile: string,
  leaseOf?: WorkerLeaseProbe,
  cache: SubagentScanCache = sharedSubagentScanCache,
): Promise<SubagentCollection> {
  if (!sessionFile.endsWith(".jsonl")) return { subagents: [], parseWarnings: [] };
  await cache.ready();
  const output: SubagentTranscript[] = [];
  const warnings: ParseWarning[] = [];
  await walkSubagentDirectory({
    root: sessionFile.slice(0, -".jsonl".length),
    parentKey: null,
    output,
    warnings,
    leaseOf,
    cache,
  });
  return { subagents: output, parseWarnings: warnings };
}
