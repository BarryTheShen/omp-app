import {
  SessionFilePath,
  type SessionSubagentsResult,
  SubagentId,
  type SubagentReadResult,
  type SubagentTranscript,
  ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { SubagentClient } from "@/modules/P1/client";
import { AgentRefSchema } from "@/modules/P1/contract";
import { createFinishedWorkerSource, type SessionTranscriptFiles } from "../finished";
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
      sessionFile: chat,
      files: files([
        worker("Done"),
        worker("Broken", { status: "failed" }),
        worker("Stopped", { status: "aborted", aborted: true }),
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
      ["Unnamed", "completed", "", "unknown"],
    ]);
  });

  test("reads a page of a finished worker's transcript through the page schema", async () => {
    const source = createFinishedWorkerSource({ threadId, sessionFile: chat, files: files([]) });
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
        sessionFile: chat,
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
        sessionFile: chat,
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
        sessionFile: chat,
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
