import {
  type SessionFile as ContractSessionFile,
  type SubagentTranscript as ContractSubagentTranscript,
  SessionDeleteResult,
  SessionFile,
  SessionFileChanged,
  SessionFilePath,
  SessionFileStore,
  ThreadId,
} from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type {
  SessionFile as InternalSessionFile,
  SubagentTranscript as InternalSubagentTranscript,
} from "../sessions";
import { sessionDisplayTitle } from "../sessions/title-card";
import type { A1PortContext } from "./context";
import { type A1EventBinding, assertNotAborted, createA1PortRegistration } from "./helper";

function mapSubagent(transcript: InternalSubagentTranscript): ContractSubagentTranscript {
  return {
    key: transcript.key,
    agentId: transcript.agentId,
    parent: transcript.parent,
    sessionFile: transcript.sessionFile as ContractSubagentTranscript["sessionFile"],
    leafId: transcript.leafId,
    entryCount: transcript.entries.length,
    aborted: transcript.aborted,
    status: transcript.status,
    endedAt: transcript.endedAt,
    agent: transcript.agent,
    ...(transcript.reason === undefined ? {} : { reason: transcript.reason }),
  };
}

/**
 * omp writes a fork's `parentSession` as a session id (for example `01a11405-b2e2-...`), and older
 * versions wrote the parent's file path. The contract holds a path: anything else is no parent
 * rather than a reason to refuse the whole list.
 */
function parentSessionPath(value: string | undefined): ContractSessionFile["parentSession"] {
  const parsed = SessionFilePath.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function mapSession(file: InternalSessionFile): ContractSessionFile {
  const title = file.title ?? null;
  return {
    id: file.id as ContractSessionFile["id"],
    sessionFile: file.sessionFile as ContractSessionFile["sessionFile"],
    version: file.version,
    title,
    displayTitle: title === null ? null : sessionDisplayTitle(title),
    firstPrompt: file.firstPrompt,
    cwd: file.cwd as ContractSessionFile["cwd"],
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    parentSession: parentSessionPath(file.parentSession),
    messageCount: file.messageCount,
    assistantTurns: file.assistantTurns,
    sizeBytes: file.sizeBytes,
    status: file.status,
    liveness: file.liveness,
    ...(file.turn === undefined ? {} : { turn: file.turn }),
    subagents: file.subagents.map(mapSubagent),
    parseWarnings: file.parseWarnings.map((warning) => warning.message),
  };
}

/**
 * A chat's turn starting or settling changes what the list shows for it, so the `changed` event tells clients to
 * re-read that chat's file. The process registry knows a chat only by its id, so the file is found from the id.
 */
function sessionTurnBindings(context: A1PortContext): readonly A1EventBinding[] {
  const busy = context.processBusy;
  if (busy === undefined) return [];
  return [
    {
      event: "changed",
      subscribe: (listener) =>
        busy.onBusyChange((threadId) => {
          context.sessionFileStore
            .findSession(threadId)
            .then((file) => {
              if (file === undefined) return;
              listener(
                SessionFileChanged.parse({
                  folder: file.cwd,
                  sessionFile: file.sessionFile,
                  id: threadId,
                  kind: "updated",
                }),
              );
            })
            .catch((error: unknown) => {
              context.logger?.warn("session.turn_unreadable", { message: String(error) });
            });
        }),
    },
  ];
}

/**
 * A removal publishes on the `changed` stream too. The delete handler calls every listener this binding registers, the
 * same way the turn bindings publish `updated` from the process registry.
 */
function removalBinding(listeners: Set<(payload: unknown) => void>): A1EventBinding {
  return {
    event: "changed",
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function createSessionFileStoreRegistration(context: A1PortContext): PortRegistration {
  const removals = new Set<(payload: unknown) => void>();
  return createA1PortRegistration(
    SessionFileStore,
    {
      listSessions: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        const result = await context.sessionFileStore.listSessions(args);
        const sessions: ContractSessionFile[] = [];
        let skipped = 0;
        let firstProblem: string | undefined;
        for (const file of result.sessions) {
          // One chat that does not fit the contract must not empty the whole list.
          const mapped = SessionFile.safeParse(mapSession(file));
          if (mapped.success) {
            sessions.push(mapped.data);
          } else {
            skipped += 1;
            const issue = mapped.error.issues[0];
            firstProblem ??=
              issue === undefined ? "invalid" : `${issue.path.join(".")}: ${issue.message}`;
          }
        }
        if (skipped > 0) {
          context.logger?.warn("sessions.skipped", { count: skipped, first_problem: firstProblem });
        }
        return {
          sessions,
          nextCursor: result.nextCursor,
          running: result.running.map((id) => ({ id: ThreadId.parse(id), folder: args.folder })),
        };
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
      readSubagent: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        const page = await context.sessionFileStore.readSubagent(args);
        return { ...page, sessionFile: page.sessionFile as ContractSessionFile["sessionFile"] };
      },
      readEntryWindow: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.sessionFileStore.readEntryWindow(args);
      },
      readEntryOutput: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.sessionFileStore.readEntryOutput(args);
      },
      deleteSession: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        const deleted = await context.sessionFileStore.deleteSession(args, {
          connectionId: handlerContext.connectionId,
        });
        if (deleted.artifactsKept !== undefined) {
          context.logger?.warn("sessions.artifacts_kept", { path: deleted.artifactsKept });
        }
        const change = SessionFileChanged.parse({
          folder: args.folder,
          sessionFile: deleted.sessionFile,
          id: deleted.id,
          kind: "removed",
        });
        for (const listener of removals) listener(change);
        return SessionDeleteResult.parse({
          id: deleted.id,
          sessionFile: deleted.sessionFile,
          removed: true,
        });
      },
    },
    context.publish,
    [...sessionTurnBindings(context), removalBinding(removals)],
    context.watchStreamActivity,
  );
}
