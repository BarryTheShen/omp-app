import {
  AppFailure,
  CapabilityStatus,
  SessionFilePath,
  type SessionSubagentsResult,
  SubagentId,
  type SubagentReadResult,
  type SubagentTranscript,
  ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { SubagentClient, SubagentSession } from "@/modules/P1/client";
import { AgentRefSchema } from "@/modules/P1/contract";
import {
  createChatFinishedWorkers,
  createFinishedWorkerSource,
  type SessionTranscriptFiles,
} from "../finished";
import { AgentRosterStore } from "../store";

const threadId = ThreadId.parse("thread-finished");
const chat = SessionFilePath.parse("/workspace/.omp/sessions/main.jsonl");
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function worker(agentId: string, overrides: Partial<SubagentTranscript> = {}): SubagentTranscript {
  return {
    key: agentId,
    agentId,
    parent: null,
    sessionFile: SessionFilePath.parse(`/workspace/.omp/sessions/main/${agentId}.jsonl`),
    leafId: "leaf",
    entryCount: 3,
    aborted: false,
    status: "completed",
    endedAt: new Date(NOW - HOUR).toISOString(),
    agent: "task",
    ...overrides,
  };
}

function page(): SubagentReadResult {
  return {
    sessionFile: SessionFilePath.parse("/workspace/.omp/sessions/main/Done.jsonl"),
    fromByte: 0,
    nextByte: 42,
    reset: false,
    entries: [{ type: "message", id: "m1" }],
    messages: [{ role: "assistant", content: [] }],
  };
}

function files(transcripts: readonly SubagentTranscript[]): SessionTranscriptFiles {
  const listing: SessionSubagentsResult = { sessionFile: chat, transcripts: [...transcripts] };
  return {
    listSubagents: async () => listing,
    readSubagent: async () => page(),
  };
}

function fakeClient(roster: readonly unknown[] = []): SubagentClient {
  return {
    getRoster: async () => AgentRefSchema.array().parse(roster),
    readTranscript: async () => {
      throw new Error("unused");
    },
    cancel: async () => ({ cancelled: true as const }),
    steer: async () => {},
    setSubscriptionLevel: async (level) => level,
    acquireSubscription: async (level) => ({ level, release: async () => {} }),
    subscribeNotifications: () => () => {},
    dispose: async () => {},
  };
}

function liveAgent(id: string) {
  return {
    id: SubagentId.parse(id),
    index: 0,
    agent: "task",
    agentSource: "bundled",
    status: "running",
    lastUpdate: NOW,
    sessionFile: SessionFilePath.parse(`/workspace/.omp/sessions/main/${id}.jsonl`),
    threadId,
  };
}

describe("finished workers read from the chat's transcripts", () => {
  test("lists the workers that ended, with their status and agent, and drops the rest", async () => {
    const source = createFinishedWorkerSource({
      threadId,
      sessionFile: async () => chat,
      files: files([
        worker("Done"),
        worker("Broken", { status: "failed" }),
        worker("Stopped", { status: "aborted", aborted: true }),
        worker("Quiet", { status: "stopped" }),
        worker("Running", { status: "unknown", endedAt: null, agent: null }),
        worker("NoEnd", { status: "completed", endedAt: null }),
        worker("Unnamed", { agent: null }),
      ]),
    });
    const listed = await source.list();
    expect(
      listed.map((item) => [
        item.agent.id,
        item.agent.status,
        item.agent.agent,
        item.agent.agentSource,
      ]),
    ).toEqual([
      ["Done", "completed", "task", "unknown"],
      ["Broken", "failed", "task", "unknown"],
      ["Stopped", "aborted", "task", "unknown"],
      ["Quiet", "stopped", "task", "unknown"],
      ["Unnamed", "completed", "", "unknown"],
    ]);
  });

  test("a finished worker that failed keeps the reason its transcript records", async () => {
    const reason = "400 fake provider failure (type=invalid_request_error)";
    const source = createFinishedWorkerSource({
      threadId,
      sessionFile: async () => chat,
      files: files([worker("Broken", { status: "failed", reason })]),
    });
    const [finished] = await source.list();
    expect(finished?.agent).toMatchObject({ id: "Broken", status: "failed", reason });
  });

  test("a worker the parent records as completed is finished, though its transcript ends in plain text", async () => {
    const source = createFinishedWorkerSource({
      threadId,
      sessionFile: async () => chat,
      files: files([worker("Plain", { status: "stopped", recordedStatus: "completed" })]),
    });
    const [finished] = await source.list();
    expect(finished?.agent).toMatchObject({ id: "Plain", status: "completed" });
  });

  test("a worker the parent records as aborted is cancelled, whatever its transcript says", async () => {
    const source = createFinishedWorkerSource({
      threadId,
      sessionFile: async () => chat,
      files: files([worker("Cut", { status: "stopped", recordedStatus: "aborted" })]),
    });
    const [finished] = await source.list();
    expect(finished?.agent).toMatchObject({ id: "Cut", status: "aborted" });
  });

  test("a worker the parent records nothing about keeps the status its transcript records", async () => {
    const source = createFinishedWorkerSource({
      threadId,
      sessionFile: async () => chat,
      files: files([worker("Quiet", { status: "stopped" })]),
    });
    const [finished] = await source.list();
    expect(finished?.agent).toMatchObject({ id: "Quiet", status: "stopped" });
  });

  test("reads a page of a finished worker's transcript through the page schema", async () => {
    const source = createFinishedWorkerSource({
      threadId,
      sessionFile: async () => chat,
      files: files([]),
    });
    const read = await source.read(
      SessionFilePath.parse("/workspace/.omp/sessions/main/Done.jsonl"),
    );
    expect(read).toMatchObject({ fromByte: 0, nextByte: 42, reset: false });
    expect(read.messages).toEqual([{ role: "assistant", content: [] }]);
  });
});

describe("a reload lists the chat's finished workers in the roster", () => {
  test("adopts a finished worker at start, keeping the moment it ended", async () => {
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      finished: createFinishedWorkerSource({
        threadId,
        sessionFile: async () => chat,
        files: files([worker("Done")]),
      }),
      clock: { now: () => NOW },
    });
    await store.start();
    const snapshot = store.getSnapshot();
    const agents = Object.values(snapshot.agents);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "Done",
      status: "completed",
      terminalAt: NOW - HOUR,
    });
    expect(snapshot.active).toEqual([]);
    expect(snapshot.recent).toContain(agents[0]?.key);
    await store.dispose();
  });

  test("keeps a worker that ended within 24 hours, and drops one that ended before", async () => {
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      finished: createFinishedWorkerSource({
        threadId,
        sessionFile: async () => chat,
        files: files([
          worker("Recent"),
          worker("Old", { endedAt: new Date(NOW - 25 * HOUR).toISOString() }),
        ]),
      }),
      clock: { now: () => NOW },
    });
    await store.start();
    const ids = Object.values(store.getSnapshot().agents).map((agent) => agent.id);
    expect(ids).toEqual(["Recent"]);
    await store.dispose();
  });

  test("a worker this connection already knows keeps its live record", async () => {
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient([liveAgent("Done")]),
      finished: createFinishedWorkerSource({
        threadId,
        sessionFile: async () => chat,
        files: files([worker("Done")]),
      }),
      clock: { now: () => NOW },
    });
    await store.start();
    const agents = Object.values(store.getSnapshot().agents);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: "Done", status: "running" });
    await store.dispose();
  });
});

/** A session whose state reports `sessionFile`, and which records every request it is asked. */
function sessionReporting(
  sessionFile: unknown,
  asked: unknown[] = [],
): Pick<SubagentSession, "request"> {
  return {
    request: async (args: unknown) => {
      asked.push(args);
      return { sessionFile };
    },
  } as unknown as Pick<SubagentSession, "request">;
}

describe("a chat's finished workers, read through its live omp", () => {
  const available = { "host.session-files": { state: "available", via: "rpc" } } as const;
  const fallback = {
    "host.session-files": CapabilityStatus.parse({
      state: "fallback",
      via: "rpc",
      detail: "Saved session files are available.",
    }),
  };
  const unavailable = {
    "host.session-files": CapabilityStatus.parse({
      state: "unavailable",
      via: "rpc",
      detail: "Session files cannot be read.",
    }),
  };

  test("asks omp for the chat's session file, then lists the workers beside it", async () => {
    const asked: unknown[] = [];
    const source = createChatFinishedWorkers({
      threadId,
      session: sessionReporting(chat, asked),
      files: files([worker("Done")]),
      capabilities: available,
    });
    const listed = await source.list();
    expect(asked).toEqual([{ threadId, method: "get_state", params: {} }]);
    expect(listed.map((item) => item.agent.id)).toEqual(["Done"]);
  });

  test("asks nothing and lists nothing when session files are unavailable", async () => {
    const asked: unknown[] = [];
    const source = createChatFinishedWorkers({
      threadId,
      session: sessionReporting(chat, asked),
      files: files([worker("Done")]),
      capabilities: unavailable,
    });
    expect(await source.list()).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("asks nothing and lists nothing when the host reports no session-files capability at all", async () => {
    const asked: unknown[] = [];
    const source = createChatFinishedWorkers({
      threadId,
      session: sessionReporting(chat, asked),
      files: files([worker("Done")]),
      capabilities: {},
    });
    expect(await source.list()).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("reads finished workers when session files are a fallback", async () => {
    const asked: unknown[] = [];
    const source = createChatFinishedWorkers({
      threadId,
      session: sessionReporting(chat, asked),
      files: files([worker("Done")]),
      capabilities: fallback,
    });
    expect((await source.list()).map((item) => item.agent.id)).toEqual(["Done"]);
    expect(asked).toEqual([{ threadId, method: "get_state", params: {} }]);
  });

  test("lists nothing while the chat has no session file, and finds its workers once it has one", async () => {
    let sessionFile: unknown;
    const source = createChatFinishedWorkers({
      threadId,
      session: {
        request: async () => ({ sessionFile }),
      } as unknown as Pick<SubagentSession, "request">,
      files: files([worker("Done")]),
      capabilities: available,
    });
    expect(await source.list()).toEqual([]);
    sessionFile = chat;
    expect((await source.list()).map((item) => item.agent.id)).toEqual(["Done"]);
  });

  test("a chat whose session file omp has not written yet lists nothing, and its roster still starts", async () => {
    const notWritten: SessionTranscriptFiles = {
      listSubagents: async () => {
        throw new AppFailure({
          code: "not_found",
          message: "Session file was not found",
          retryable: false,
        });
      },
      readSubagent: async () => {
        throw new Error("unused");
      },
    };
    const source = createChatFinishedWorkers({
      threadId,
      session: sessionReporting(chat),
      files: notWritten,
      capabilities: available,
    });
    expect(await source.list()).toEqual([]);
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      finished: source,
      clock: { now: () => NOW },
    });
    await expect(store.start()).resolves.toBeUndefined();
    expect(store.getSnapshot().recent).toEqual([]);
    await store.dispose();
  });

  test("any other failure reading the chat's files is still an error", async () => {
    const broken: SessionTranscriptFiles = {
      listSubagents: async () => {
        throw new AppFailure({
          code: "permission",
          message: "Unable to read omp session file",
          retryable: true,
        });
      },
      readSubagent: async () => {
        throw new Error("unused");
      },
    };
    const source = createChatFinishedWorkers({
      threadId,
      session: sessionReporting(chat),
      files: broken,
      capabilities: available,
    });
    await expect(source.list()).rejects.toMatchObject({ appError: { code: "permission" } });
  });
});

describe("a chat whose session file omp has not written yet", () => {
  test("lists no finished workers instead of failing the roster that asks for them", async () => {
    const notWritten: SessionTranscriptFiles = {
      listSubagents: async () => {
        throw new AppFailure({
          code: "not_found",
          message: "Session file was not found",
          retryable: false,
        });
      },
      readSubagent: async () => page(),
    };
    const source = createFinishedWorkerSource({
      threadId,
      sessionFile: async () => chat,
      files: notWritten,
    });
    await expect(source.list()).resolves.toEqual([]);
  });
});
