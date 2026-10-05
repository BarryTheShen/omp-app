import {
  type SessionFile as ContractSessionFile,
  type SubagentTranscript as ContractSubagentTranscript,
  SessionFileStore,
} from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type {
  SessionFile as InternalSessionFile,
  SubagentTranscript as InternalSubagentTranscript,
} from "../sessions";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

function mapSubagent(transcript: InternalSubagentTranscript): ContractSubagentTranscript {
  return {
    key: transcript.key,
    agentId: transcript.agentId,
    parent: transcript.parent,
    sessionFile: transcript.sessionFile as ContractSubagentTranscript["sessionFile"],
    leafId: transcript.leafId,
    entryCount: transcript.entries.length,
    aborted: transcript.aborted,
  };
}

function mapSession(file: InternalSessionFile): ContractSessionFile {
  return {
    id: file.id as ContractSessionFile["id"],
    sessionFile: file.sessionFile as ContractSessionFile["sessionFile"],
    version: file.version,
    title: file.title ?? null,
    cwd: file.cwd as ContractSessionFile["cwd"],
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    parentSession: (file.parentSession ?? null) as ContractSessionFile["parentSession"],
    messageCount: file.messageCount,
    assistantTurns: file.assistantTurns,
    sizeBytes: file.sizeBytes,
    status: file.status,
    liveness: file.liveness,
    subagents: file.subagents.map(mapSubagent),
    parseWarnings: file.parseWarnings.map((warning) => warning.message),
  };
}

export function createSessionFileStoreRegistration(context: A1PortContext): PortRegistration {
  return createA1PortRegistration(
    SessionFileStore,
    {
      listSessions: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        const result = await context.sessionFileStore.listSessions(args);
        return { sessions: result.sessions.map(mapSession), nextCursor: result.nextCursor };
      },
      listFolders: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        const result = await context.sessionFileStore.listFolders(args);
        return {
          folders: [...result.folders] as ContractSessionFile["cwd"][],
          nextCursor: result.nextCursor,
        };
      },
      readSession: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return mapSession(await context.sessionFileStore.readSession(args));
      },
      listSubagents: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        const result = await context.sessionFileStore.listSubagents(args);
        return {
          sessionFile: result.sessionFile as ContractSessionFile["sessionFile"],
          transcripts: result.transcripts.map(mapSubagent),
        };
      },
    },
    context.publish,
  );
}
