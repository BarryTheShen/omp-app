import {
  type PortCallOptions,
  type SessionFilePath,
  type SessionReadArgs,
  type SessionSubagentsResult,
  SubagentId,
  type SubagentReadArgs,
  type SubagentReadResult,
  type SubagentTranscript,
  type ThreadId,
} from "@omp-app/contracts";
import { SubagentTranscriptPageSchema } from "@/modules/P1/contract";
import type { FinishedWorker, FinishedWorkerSource } from "./types";

/** The two session-file reads a finished-worker source makes; the SessionFileStore port client has both. */
export interface SessionTranscriptFiles {
  listSubagents(args: SessionReadArgs, options?: PortCallOptions): Promise<SessionSubagentsResult>;
  readSubagent(args: SubagentReadArgs, options?: PortCallOptions): Promise<SubagentReadResult>;
}

export interface FinishedWorkerSourceOptions {
  readonly threadId: ThreadId;
  /** The chat's own session file: its workers sit beside it. */
  readonly sessionFile: SessionFilePath;
  readonly files: SessionTranscriptFiles;
}

/** A transcript that ended, as a roster entry. One that records no end may still be running. */
function finishedWorker(threadId: ThreadId, transcript: SubagentTranscript): FinishedWorker[] {
  const { status, endedAt } = transcript;
  if (endedAt === null) return [];
  if (status !== "completed" && status !== "failed" && status !== "aborted") return [];
  const endedMs = Date.parse(endedAt);
  if (!Number.isFinite(endedMs)) return [];
  return [
    {
      endedAt: endedMs,
      agent: {
        id: SubagentId.parse(transcript.agentId),
        index: 0,
        agent: transcript.agent ?? "",
        agentSource: "unknown",
        status,
        lastUpdate: endedMs,
        sessionFile: transcript.sessionFile,
        threadId,
      },
    },
  ];
}

/**
 * The chat's finished workers, read from its transcripts beside its session file. After a reload this
 * is the only record of a finished worker: omp forgets it, but its transcript stays on disk. Both
 * reads are read-only on the server.
 */
export function createFinishedWorkerSource(
  options: FinishedWorkerSourceOptions,
): FinishedWorkerSource {
  const { threadId, sessionFile, files } = options;
  const source: FinishedWorkerSource = {
    list: async () => {
      const listing = await files.listSubagents({ sessionFile });
      return listing.transcripts.flatMap((transcript) => finishedWorker(threadId, transcript));
    },
    read: async (file: SessionFilePath, fromByte?: number) => {
      const page = await files.readSubagent({
        sessionFile: file,
        ...(fromByte === undefined ? {} : { fromByte }),
      });
      return SubagentTranscriptPageSchema.parse(page);
    },
  };
  return Object.freeze(source);
}
