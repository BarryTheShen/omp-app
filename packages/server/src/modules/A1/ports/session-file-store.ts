import {
  type SessionFile as ContractSessionFile,
  type SubagentTranscript as ContractSubagentTranscript,
  SessionContinueChanged,
  SessionDeleteResult,
  SessionFile,
  SessionFileChanged,
  SessionFilePath,
  SessionFileStore,
  SessionPauseChanged,
  SessionRunningChanged,
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
    entryCount: transcript.entryCount,
    aborted: transcript.aborted,
    status: transcript.status,
    endedAt: transcript.endedAt,
    agent: transcript.agent,
    ...(transcript.reason === undefined ? {} : { reason: transcript.reason }),
    ...(transcript.recordedStatus === undefined
      ? {}
      : { recordedStatus: transcript.recordedStatus }),
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
 * A chat's turn starting or settling changes what the list shows. The running-list event carries the process registry's
 * folder even before omp writes a session file; the file event then tells clients to re-read that file when it exists.
 */
function sessionTurnBindings(context: A1PortContext): readonly A1EventBinding[] {
  const busy = context.processBusy;
  if (busy === undefined) return [];
  return [
    {
      event: "runningChanged",
      subscribe: (listener) =>
        busy.onBusyChange((threadId, isBusy) => {
          const payload = SessionRunningChanged.safeParse({
            folder: busy.folderOf(threadId),
            id: threadId,
            busy: isBusy,
          });
          if (payload.success) listener(payload.data);
        }),
    },
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

/** A chat's pause starting or ending (omp's `/pause`, or its omp gone) changes the mark its row shows. */
function sessionPauseBindings(context: A1PortContext): readonly A1EventBinding[] {
  const pause = context.processPause;
  if (pause === undefined) return [];
  return [
    {
      event: "pauseChanged",
      subscribe: (listener) =>
        pause.onPauseChange((threadId, folder, pausedAt) => {
          const payload = SessionPauseChanged.safeParse({ folder, id: threadId, pausedAt });
          if (payload.success) listener(payload.data);
        }),
    },
  ];
}

/** A chat the app will continue after its usage limit, or no longer will (#2781), changes the time its row shows. */
function sessionContinueBindings(context: A1PortContext): readonly A1EventBinding[] {
  const continuing = context.processContinue;
  if (continuing === undefined) return [];
  return [
    {
      event: "continueChanged",
      subscribe: (listener) =>
        continuing.onContinueChange((threadId, folder, continuesAt) => {
          const payload = SessionContinueChanged.safeParse({ folder, id: threadId, continuesAt });
          if (payload.success) listener(payload.data);
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

/**
 * A chat whose cached listing facts were stale is read again in the background, and then published as updated, so clients
 * read it again. A background read or write that failed is logged; the listing carries on without it.
 */
function refreshBinding(context: A1PortContext): A1EventBinding {
  return {
    event: "changed",
    subscribe: (listener) =>
      context.sessionFileStore.onBackground((event) => {
        if (event.kind === "failed") {
          context.logger?.warn("sessions.refresh_failed", {
            message: event.message,
            ...(event.sessionFile === undefined ? {} : { session_file: event.sessionFile }),
          });
          return;
        }
        const change = SessionFileChanged.safeParse({
          folder: event.cwd,
          sessionFile: event.sessionFile,
          id: event.id,
          kind: "updated",
        });
        if (change.success) listener(change.data);
      }),
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
      readSessionRow: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return mapSession(await context.sessionFileStore.readSessionRow(args));
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
      listPaused: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return { chats: [...(context.processPause?.pausedIn(args.folder) ?? [])] };
      },
      listContinuing: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return { chats: [...(context.processContinue?.continuingIn(args.folder) ?? [])] };
      },
    },
    context.publish,
    [
      ...sessionTurnBindings(context),
      ...sessionPauseBindings(context),
      ...sessionContinueBindings(context),
      removalBinding(removals),
      refreshBinding(context),
    ],
    context.watchStreamActivity,
  );
}
