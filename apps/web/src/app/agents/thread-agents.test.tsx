import type { CapabilityMap } from "@omp-app/contracts";
import { SessionFilePath, ThreadId, ToolCallId } from "@omp-app/contracts";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, describe, expect, test } from "vitest";
import type { SubagentSession } from "@/modules/P1/client";
import type { SessionTranscriptFiles } from "@/modules/P1/roster";
import { OmpRuntimeStore } from "@/modules/R0/store";
import { TaskSubagentsContext } from "@/modules/T5/task";
import { AGENT_CAPABILITIES } from "./agents-tab";
import { createThreadAgents, startWorkerStream } from "./thread-agents";
import { TaskSubagentsScope, useThreadAgents } from "./thread-agents-scope";

afterEach(() => {
  cleanup();
});

const threadA = ThreadId.parse("thread-a");
const threadB = ThreadId.parse("thread-b");

function allCapabilities(): CapabilityMap {
  const capabilities: CapabilityMap = {};
  for (const key of AGENT_CAPABILITIES) capabilities[key] = { state: "available", via: "rpc" };
  return capabilities;
}

// Memoized: the hook keys its chat on these inputs, so a fresh object each render would remake the chat.
const CAPABILITIES = allCapabilities();

// These chats have no session files in these tests, so nothing may read them.
const unreadFiles: SessionTranscriptFiles = {
  listSubagents: async () => {
    throw new Error("the session files are read only with the session-files capability");
  },
  readSubagent: async () => {
    throw new Error("the session files are read only with the session-files capability");
  },
};

/** The chat's files after a reload: one worker finished in them, and omp's live roster has none. */
function filesWithFinishedWorker(): SessionTranscriptFiles {
  const sessionFile = SessionFilePath.parse("/workspace/.omp/sessions/main.jsonl");
  return {
    listSubagents: async () => ({
      sessionFile,
      transcripts: [
        {
          key: "worker-1",
          agentId: "worker-1",
          parent: null,
          sessionFile: SessionFilePath.parse("/workspace/.omp/sessions/main/worker-1.jsonl"),
          leafId: "leaf",
          entryCount: 3,
          aborted: false,
          status: "completed",
          endedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          agent: "task",
        },
      ],
    }),
    readSubagent: async () => {
      throw new Error("unused");
    },
  };
}

/** A fake omp: one worker that the task call "call-1" started, and every subscription level it is asked for. */
function fakeOmp() {
  const levels: Array<{ readonly threadId: string; readonly level: string }> = [];
  const session = {
    request: async (args: { method: string }) => {
      if (args.method === "get_subagents") {
        return {
          subagents: [
            {
              id: "worker-1",
              index: 0,
              agent: "worker",
              agentSource: "project",
              status: "running",
              lastUpdate: 1_759_600_000_000,
              task: "work",
              progress: { phase: "working" },
              sessionFile: "/workspace/.omp/worker-1.jsonl",
              parentToolCallId: "call-1",
            },
          ],
        };
      }
      throw new Error(`unexpected method ${args.method}`);
    },
    setSubagentSubscription: async (args: { threadId: string; level: string }) => {
      levels.push({ threadId: args.threadId, level: args.level });
      return { level: args.level };
    },
  } as unknown as SubagentSession;
  return { session, levels };
}

describe("ThreadAgents", () => {
  test("nothing is subscribed until the first start, and later starts wait for that one", async () => {
    const omp = fakeOmp();
    const agents = createThreadAgents({
      threadId: threadA,
      store: new OmpRuntimeStore({ threadId: threadA }),
      session: omp.session,
      files: unreadFiles,
      capabilities: CAPABILITIES,
    });
    expect(omp.levels).toEqual([]);
    const first = agents.start();
    expect(agents.start()).toBe(first);
    await first;
    expect(omp.levels).toEqual([{ threadId: threadA, level: "progress" }]);
    await agents.dispose();
  });

  test("a task call finds its workers in the roster, with one source per worker", async () => {
    const omp = fakeOmp();
    const agents = createThreadAgents({
      threadId: threadA,
      store: new OmpRuntimeStore({ threadId: threadA }),
      session: omp.session,
      files: unreadFiles,
      capabilities: CAPABILITIES,
    });
    await agents.start();
    const found = agents.subagentsFor(ToolCallId.parse("call-1"));
    expect(found.map(({ agent }) => agent.id)).toEqual(["worker-1"]);
    expect(agents.subagentsFor(ToolCallId.parse("call-1"))[0]?.source).toBe(found[0]?.source);
    expect(agents.subagentsFor(ToolCallId.parse("call-2"))).toEqual([]);
    await agents.dispose();
  });

  test("a notice finds its worker by the id omp gave it, with the source the task card uses", async () => {
    const omp = fakeOmp();
    const agents = createThreadAgents({
      threadId: threadA,
      store: new OmpRuntimeStore({ threadId: threadA }),
      session: omp.session,
      files: unreadFiles,
      capabilities: CAPABILITIES,
    });
    await agents.start();
    const worker = agents.workerFor("worker-1");
    expect(worker?.agent.id).toBe("worker-1");
    expect(worker?.source).toBe(agents.subagentsFor(ToolCallId.parse("call-1"))[0]?.source);
    expect(agents.workerFor("nobody")).toBeUndefined();
    await agents.dispose();
  });

  test("a task card finds a worker by the id its result names, even without a link to the call", async () => {
    const omp = fakeOmp();
    const agents = createThreadAgents({
      threadId: threadA,
      store: new OmpRuntimeStore({ threadId: threadA }),
      session: omp.session,
      files: unreadFiles,
      capabilities: CAPABILITIES,
    });
    await agents.start();
    const byId = agents.subagentsFor(ToolCallId.parse("call-2"), ["worker-1"]);
    expect(byId.map(({ agent }) => agent.id)).toEqual(["worker-1"]);
    expect(agents.subagentsFor(ToolCallId.parse("call-2"), ["another-worker"])).toEqual([]);
    await agents.dispose();
  });

  test("a worker that ended before the roster subscribed is listed from its transcript, and found by its id", async () => {
    const session = {
      request: async (args: { method: string }) => {
        if (args.method === "get_subagents") return { subagents: [] };
        if (args.method === "get_state") return { sessionFile: "/workspace/.omp/chat.jsonl" };
        throw new Error(`unexpected method ${args.method}`);
      },
      setSubagentSubscription: async (args: { level: string }) => ({ level: args.level }),
    } as unknown as SubagentSession;
    const files = {
      listSubagents: async () => ({
        transcripts: [
          {
            key: "chat/NestedProbe",
            agentId: "NestedProbe",
            parent: null,
            sessionFile: "/workspace/.omp/NestedProbe.jsonl",
            leafId: "entry-2",
            entryCount: 2,
            aborted: false,
            status: "completed",
            // An hour ago: inside the roster's 24-hour retention however old the clock gets.
            endedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            agent: "task",
          },
        ],
      }),
      readSubagent: async () => {
        throw new Error("the roster only lists transcripts");
      },
    } as unknown as SessionTranscriptFiles;
    const agents = createThreadAgents({
      threadId: threadA,
      store: new OmpRuntimeStore({ threadId: threadA }),
      session,
      capabilities: { ...CAPABILITIES, "host.session-files": { state: "available", via: "rpc" } },
      files,
    });
    await agents.start();
    const found = agents.subagentsFor(ToolCallId.parse("call-9"), ["NestedProbe"]);
    expect(found.map(({ agent }) => ({ id: agent.id, status: agent.status }))).toEqual([
      { id: "NestedProbe", status: "completed" },
    ]);
    await agents.dispose();
  });

  test("disposing releases the progress subscription once, and a second dispose does nothing", async () => {
    const omp = fakeOmp();
    const agents = createThreadAgents({
      threadId: threadA,
      store: new OmpRuntimeStore({ threadId: threadA }),
      session: omp.session,
      files: unreadFiles,
      capabilities: CAPABILITIES,
    });
    await agents.start();
    await agents.dispose();
    await agents.dispose();
    expect(omp.levels).toEqual([
      { threadId: threadA, level: "progress" },
      { threadId: threadA, level: "off" },
    ]);
  });

  test("after a reload, a worker that finished in the chat's files is in its roster", async () => {
    const session = {
      request: async (args: { method: string }) => {
        if (args.method === "get_subagents") return { subagents: [] };
        if (args.method === "get_state") {
          return { sessionFile: "/workspace/.omp/sessions/main.jsonl" };
        }
        throw new Error(`unexpected method ${args.method}`);
      },
      setSubagentSubscription: async (args: { level: string }) => ({ level: args.level }),
    } as unknown as SubagentSession;
    const capabilities: CapabilityMap = {
      ...CAPABILITIES,
      "host.session-files": { state: "available", via: "rpc" },
    };
    const agents = createThreadAgents({
      threadId: threadA,
      store: new OmpRuntimeStore({ threadId: threadA }),
      session,
      files: filesWithFinishedWorker(),
      capabilities,
    });
    await agents.start();
    const { agents: byKey, recent } = agents.roster.getSnapshot();
    expect(recent.map((key) => byKey[key]?.id)).toEqual(["worker-1"]);
    await agents.dispose();
  });
});

/** A task card's lookup as the transcript gives it: it prints the ids of the workers the call started. */
function Card() {
  const lookup = useContext(TaskSubagentsContext);
  const found = lookup?.(ToolCallId.parse("call-1")) ?? [];
  return <p data-testid="workers">{found.map(({ agent }) => agent.id).join(",")}</p>;
}

function Chat({
  threadId,
  store,
  session,
  withCard,
}: {
  readonly threadId: ThreadId;
  readonly store: OmpRuntimeStore;
  readonly session: SubagentSession;
  readonly withCard: boolean;
}) {
  const agents = useThreadAgents({
    threadId,
    store,
    session,
    files: unreadFiles,
    capabilities: CAPABILITIES,
  });
  return (
    <TaskSubagentsScope agents={agents}>{withCard ? <Card /> : <p>No cards</p>}</TaskSubagentsScope>
  );
}

describe("the chat's subagents in the transcript", () => {
  test("no subscription until a task card asks for its workers", async () => {
    const omp = fakeOmp();
    render(
      <Chat
        session={omp.session}
        store={new OmpRuntimeStore({ threadId: threadA })}
        threadId={threadA}
        withCard={false}
      />,
    );
    await waitFor(() => expect(omp.levels).toEqual([]));
  });

  test("the first card to ask starts the roster; switching or closing the chat releases it", async () => {
    const omp = fakeOmp();
    const storeA = new OmpRuntimeStore({ threadId: threadA });
    const storeB = new OmpRuntimeStore({ threadId: threadB });
    const view = render(<Chat session={omp.session} store={storeA} threadId={threadA} withCard />);
    await waitFor(() =>
      expect(omp.levels).toContainEqual({ threadId: threadA, level: "progress" }),
    );
    await waitFor(() => expect(view.getByTestId("workers").textContent).toBe("worker-1"));

    view.rerender(<Chat session={omp.session} store={storeB} threadId={threadB} withCard />);
    await waitFor(() => expect(omp.levels).toContainEqual({ threadId: threadA, level: "off" }));
    await waitFor(() =>
      expect(omp.levels).toContainEqual({ threadId: threadB, level: "progress" }),
    );

    view.unmount();
    await waitFor(() => expect(omp.levels).toContainEqual({ threadId: threadB, level: "off" }));
  });

  test("closing a chat whose roster release is refused raises no unhandled error", async () => {
    const omp = fakeOmp();
    // The connection is already refused (an expired launch link), so the release that closing the chat sends fails.
    const levels: Array<{ readonly threadId: string; readonly level: string }> = [];
    const refused = {
      request: omp.session.request,
      setSubagentSubscription: async (args: { threadId: string; level: string }) => {
        levels.push(args);
        if (args.level === "off") throw new Error("Launch link has expired");
        return { level: args.level };
      },
    } as unknown as SubagentSession;
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      const view = render(
        <Chat
          session={refused}
          store={new OmpRuntimeStore({ threadId: threadA })}
          threadId={threadA}
          withCard
        />,
      );
      await waitFor(() => expect(view.getByTestId("workers").textContent).toBe("worker-1"));
      view.unmount();
      await waitFor(() => expect(levels).toContainEqual({ threadId: threadA, level: "off" }));
      // An error nobody handles is reported once the queue drains: give it a turn before the check.
      const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
      setTimeout(settle, 20);
      await settled;
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
});

describe("the chat's worker stream", () => {
  test("is requested once for the chat, and asks omp for progress before any card asks", async () => {
    const omp = fakeOmp();
    const agents = createThreadAgents({
      threadId: threadA,
      store: new OmpRuntimeStore({ threadId: threadA }),
      session: omp.session,
      files: unreadFiles,
      capabilities: CAPABILITIES,
    });
    startWorkerStream(agents);
    startWorkerStream(agents);
    await waitFor(() => expect(omp.levels).toEqual([{ threadId: threadA, level: "progress" }]));
    await agents.dispose();
  });
});
