import type { RpcSessionEvent } from "@omp-app/contracts";
import { type CapabilityMap, SubagentId, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { P1CapabilityKeys } from "@/modules/P1/contract";
import { OmpRuntimeStore, type OmpRuntimeTransport } from "@/modules/R0/store";
import { createSubagentClient, type SubagentClient, type SubagentSession } from "../client";

const threadId = ThreadId.parse("thread-p1");
const subagentId = SubagentId.parse("agent-1");
const sessionFile = "/workspace/.omp/agent-1.jsonl";

function availableCapabilities(): CapabilityMap {
  return Object.fromEntries(
    Object.values(P1CapabilityKeys).map((key) => [
      key,
      { state: "available", via: key.startsWith("host.") ? "host" : "rpc" },
    ]),
  ) as CapabilityMap;
}

function fakeClient(
  options: {
    readonly capabilities?: CapabilityMap;
    readonly cancelled?: boolean;
    readonly levels?: string[];
    readonly sent?: Array<{ type: string; args: unknown }>;
  } = {},
): { client: SubagentClient; runtime: OmpRuntimeStore; session: SubagentSession } {
  const sent = options.sent ?? [];
  const levels = options.levels ?? [];
  const runtime = new OmpRuntimeStore({ threadId, transport: {} as OmpRuntimeTransport });
  const send = async (args: { command: { type: string } }): Promise<unknown> => {
    sent.push({ type: args.command.type, args: args.command });
    switch (args.command.type) {
      case "get_subagents":
        return {
          subagents: [
            {
              id: subagentId,
              index: 0,
              agent: "worker",
              agentSource: "project",
              status: "running",
              lastUpdate: 1_759_600_000_000,
              task: "work",
              progress: { phase: "working" },
              sessionFile,
              parentToolCallId: "tool-1",
            },
          ],
        };
      case "get_subagent_messages":
        return {
          sessionFile,
          fromByte: 10,
          nextByte: 20,
          reset: false,
          entries: [{ type: "message", id: "entry-1" }],
          messages: [{ role: "user", content: "hello", timestamp: 1 }],
        };
      case "cancel_subagent":
        return { cancelled: options.cancelled ?? true };
      case "steer_subagent":
        return undefined;
      default:
        throw new Error(`unexpected command ${args.command.type}`);
    }
  };
  const setSubagentSubscription = async (args: { level: "off" | "progress" | "events" }) => {
    levels.push(args.level);
    return { level: args.level };
  };
  const session = { send, setSubagentSubscription } as SubagentSession;
  const client = createSubagentClient({
    threadId,
    session,
    runtime,
    capabilities: options.capabilities ?? availableCapabilities(),
  });
  return { client, runtime, session };
}

describe("P1 subagent client commands", () => {
  test("sends every typed command and reads an incremental page", async () => {
    const sent: Array<{ type: string; args: unknown }> = [];
    const { client } = fakeClient({ sent });
    const roster = await client.getRoster();
    expect(roster[0]).toMatchObject({ id: subagentId, status: "running", threadId });
    const page = await client.readTranscript(subagentId, { fromByte: 10 });
    expect(page).toMatchObject({ sessionFile, fromByte: 10, nextByte: 20, reset: false });
    await client.steer(subagentId, "continue the work");
    await client.cancel(subagentId);
    expect(sent.map((item) => item.type)).toEqual([
      "get_subagents",
      "get_subagent_messages",
      "steer_subagent",
      "cancel_subagent",
    ]);
    expect(sent[1]?.args).toMatchObject({ subagentId, fromByte: 10 });
    await client.dispose();
  });

  test("rejects unavailable capabilities before sending", async () => {
    const sent: Array<{ type: string; args: unknown }> = [];
    const capabilities = availableCapabilities();
    capabilities[P1CapabilityKeys.steer] = {
      state: "unavailable",
      via: "rpc",
      detail: "not released",
    };
    const { client } = fakeClient({ capabilities, sent });
    await expect(client.steer(subagentId, "hello")).rejects.toMatchObject({
      appError: { code: "unavailable", capability: P1CapabilityKeys.steer },
    });
    expect(sent).toEqual([]);
    await client.dispose();
  });

  test("turns cancelled false into not_found rather than success", async () => {
    const { client } = fakeClient({ cancelled: false });
    await expect(client.cancel(subagentId)).rejects.toMatchObject({
      appError: { code: "not_found" },
    });
    await client.dispose();
  });
});

describe("P1 subscription arbitration and R0 notification handoff", () => {
  test("raises progress/events levels and releases them in order", async () => {
    const levels: string[] = [];
    const { client } = fakeClient({ levels });
    const progress = await client.acquireSubscription("progress");
    const events = await client.acquireSubscription("events");
    expect(levels).toEqual(["progress", "events"]);
    await events.release();
    expect(levels).toEqual(["progress", "events", "progress"]);
    await progress.release();
    expect(levels).toEqual(["progress", "events", "progress", "off"]);
    await client.dispose();
  });

  test("forwards lifecycle/progress/event frames from the one R0 notification stream in seq order", async () => {
    const { client, runtime } = fakeClient();
    const received: Array<{ type: string; seq: number }> = [];
    const unsubscribe = client.subscribeNotifications(({ event, seq }) => {
      received.push({ type: event.type, seq });
    });
    const lifecycle: RpcSessionEvent = {
      kind: "notification",
      frame: {
        type: "subagent_lifecycle",
        payload: {
          id: subagentId,
          agent: "worker",
          agentSource: "project",
          status: "started",
          index: 0,
        },
      },
    };
    const progress: RpcSessionEvent = {
      kind: "notification",
      frame: {
        type: "subagent_progress",
        payload: {
          index: 0,
          agent: "worker",
          agentSource: "project",
          task: "work",
          progress: { phase: "working" },
        },
      },
    };
    const nested: RpcSessionEvent = {
      kind: "notification",
      frame: {
        type: "subagent_event",
        payload: { id: subagentId, event: { type: "agent_start" } },
      },
    };
    runtime.ingest(lifecycle, 1);
    runtime.ingest(progress, 2);
    runtime.ingest(nested, 3);
    expect(received).toEqual([
      { type: "subagent_lifecycle", seq: 1 },
      { type: "subagent_progress", seq: 2 },
      { type: "subagent_event", seq: 3 },
    ]);
    unsubscribe();
    await client.dispose();
  });
});
