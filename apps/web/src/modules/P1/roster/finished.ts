import {
  AppFailure,
  type CapabilityMap,
  type PortCallOptions,
  SessionFilePath,
  type SessionReadArgs,
  type SessionSubagentsResult,
  SubagentId,
  type SubagentReadArgs,
  type SubagentReadResult,
  type SubagentTranscript,
  type ThreadId,
} from "@omp-app/contracts";
import type { SubagentSession } from "@/modules/P1/client";
import { SubagentTranscriptPageSchema } from "@/modules/P1/contract";
import { isUsable } from "@/registry-core/hooks";
import type { FinishedWorker, FinishedWorkerSource } from "./types";

/** The two session-file reads a finished-worker source makes; the SessionFileStore port client has both. */
export interface SessionTranscriptFiles {
  listSubagents(args: SessionReadArgs, options?: PortCallOptions): Promise<SessionSubagentsResult>;
  readSubagent(args: SubagentReadArgs, options?: PortCallOptions): Promise<SubagentReadResult>;
}

export interface FinishedWorkerSourceOptions {
  readonly threadId: ThreadId;
  /** The chat's own session file, asked for each time the list is read: its workers sit beside it. */
  readonly sessionFile: () => Promise<SessionFilePath | undefined>;
  readonly files: SessionTranscriptFiles;
}

/**
 * A transcript that ended, as a roster entry. The outcome omp recorded for the worker in its parent's task result wins,
 * the same record the task card reads; without one, the transcript's own end decides. One that records no end may
 * still be running.
 */
function finishedWorker(threadId: ThreadId, transcript: SubagentTranscript): FinishedWorker[] {
  const status = transcript.recordedStatus ?? transcript.status;
  const { endedAt } = transcript;
  if (endedAt === null) return [];
  if (status === "unknown") return [];
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
        ...(transcript.reason === undefined ? {} : { reason: transcript.reason }),
        threadId,
      },
    },
  ];
}

/**
 * The chat's worker transcripts. omp has not written a new chat's session file before its first turn, and
 * the listing then reports it missing: that chat has no finished workers. Any other failure is still an error.
 */
async function transcriptsOf(
  files: SessionTranscriptFiles,
  sessionFile: SessionFilePath,
): Promise<readonly SubagentTranscript[]> {
  try {
    return (await files.listSubagents({ sessionFile })).transcripts;
  } catch (error) {
    if (error instanceof AppFailure && error.appError.code === "not_found") return [];
    throw error;
  }
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
      const file = await sessionFile();
      if (file === undefined) return [];
      const transcripts = await transcriptsOf(files, file);
      return transcripts.flatMap((transcript) => finishedWorker(threadId, transcript));
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

/** What a chat-scoped finished-worker source needs: the chat, its session port, its files and what omp can do. */
export interface ChatFinishedWorkersOptions {
  readonly threadId: ThreadId;
  readonly session: Pick<SubagentSession, "request">;
  readonly files: SessionTranscriptFiles;
  readonly capabilities: CapabilityMap;
}

/**
 * The chat's finished workers, for a reload to list. The chat's session file is asked of omp when the list is
 * read, so a chat that had no file when it opened still finds its workers once it has one. Without the
 * session-files capability there is nothing to read, and nothing is asked.
 */
export function createChatFinishedWorkers(
  options: ChatFinishedWorkersOptions,
): FinishedWorkerSource {
  const { threadId, session, files, capabilities } = options;
  return createFinishedWorkerSource({
    threadId,
    files,
    sessionFile: async () => {
      if (!isUsable(capabilities, "host.session-files")) return undefined;
      const state = await session.request({ threadId, method: "get_state", params: {} });
      const parsed = SessionFilePath.safeParse(state.sessionFile);
      return parsed.success ? parsed.data : undefined;
    },
  });
}
