import { CapabilityKey, SubagentId, ThreadId, ToolCallId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  AdvisorStateSchema,
  AgentRefSchema,
  AgentRosterSnapshotSchema,
  P1CapabilityKeys,
  SubagentEventPayloadSchema,
  SubagentLifecyclePayloadSchema,
  SubagentProgressPayloadSchema,
  SubagentTranscriptPageSchema,
} from ".";

const subagentId = SubagentId.parse("agent-1");
const threadId = ThreadId.parse("thread-1");
const toolCallId = ToolCallId.parse("tool-1");
const sessionFile = "/workspace/.omp/session.jsonl";

const agent = {
  id: subagentId,
  index: 0,
  agent: "worker",
  agentSource: "project" as const,
  status: "running" as const,
  lastUpdate: 1_759_600_000_000,
  description: "Build a thing",
  task: "thing",
  assignment: "assignment",
  progress: { phase: "working", percent: 50 },
  sessionFile,
  parentToolCallId: toolCallId,
  detached: false,
  threadId,
};

describe("P1 agent contracts", () => {
  test("brands ids and accepts a roster snapshot with lineage metadata", () => {
    expect(AgentRefSchema.safeParse(agent).success).toBe(true);
    expect(
      AgentRosterSnapshotSchema.safeParse({
        threadId,
        subagents: [agent],
        subscriptionLevel: "progress",
        receivedSeq: 12,
        revision: 3,
      }).success,
    ).toBe(true);
    expect(AgentRefSchema.safeParse({ ...agent, id: "" }).success).toBe(false);
    expect(
      AgentRefSchema.safeParse({ ...agent, sessionFile: "relative/session.jsonl" }).success,
    ).toBe(false);
    expect(
      AgentRosterSnapshotSchema.safeParse({ ...agent, subagents: "not-an-array" }).success,
    ).toBe(false);
  });

  test("accepts lifecycle/progress/event payloads and rejects malformed correlations", () => {
    expect(
      SubagentLifecyclePayloadSchema.safeParse({
        id: subagentId,
        agent: "worker",
        agentSource: "project",
        status: "completed",
        index: 0,
        sessionFile,
        parentToolCallId: toolCallId,
        detached: true,
      }).success,
    ).toBe(true);
    expect(
      SubagentProgressPayloadSchema.safeParse({
        index: 0,
        agent: "worker",
        agentSource: "project",
        task: "thing",
        progress: { phase: "working" },
        sessionFile,
      }).success,
    ).toBe(true);
    expect(
      SubagentEventPayloadSchema.safeParse({
        id: subagentId,
        event: { type: "agent_start" },
      }).success,
    ).toBe(true);
    expect(
      SubagentProgressPayloadSchema.safeParse({
        index: -1,
        agent: "worker",
        agentSource: "project",
        task: "thing",
        progress: {},
      }).success,
    ).toBe(false);
    expect(
      SubagentEventPayloadSchema.safeParse({ id: "", event: { type: "agent_start" } }).success,
    ).toBe(false);
  });

  test("handles incremental transcript cursors, including reset pages", () => {
    const page = {
      sessionFile,
      fromByte: 100,
      nextByte: 140,
      reset: false,
      entries: [{ type: "message", id: "entry-1" }],
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    };
    expect(SubagentTranscriptPageSchema.safeParse(page).success).toBe(true);
    expect(SubagentTranscriptPageSchema.safeParse({ ...page, nextByte: 90 }).success).toBe(false);
    expect(
      SubagentTranscriptPageSchema.safeParse({ ...page, nextByte: 0, reset: true }).success,
    ).toBe(true);
    expect(
      SubagentTranscriptPageSchema.safeParse({ ...page, messages: [{ content: "no role" }] })
        .success,
    ).toBe(false);
  });

  test("keeps advisor state and capability mapping explicit", () => {
    expect(
      AdvisorStateSchema.safeParse({
        mode: "on",
        status: "working",
        advisor: "reviewer",
        model: "model-id",
        note: { text: "Reviewing", severity: "info", delayedTurns: 2 },
        updatedAt: 1_759_600_000_000,
      }).success,
    ).toBe(true);
    expect(
      AdvisorStateSchema.safeParse({ mode: "on", status: "working", note: null, extra: true })
        .success,
    ).toBe(false);
    expect(Object.values(P1CapabilityKeys)).toEqual([
      "omp.cmd.get_subagents",
      "omp.cmd.get_subagent_messages",
      "omp.cmd.cancel_subagent",
      "omp.cmd.steer_subagent",
      "omp.cmd.set_subagent_subscription",
      "omp.subagent-events",
      "host.config",
      "host.command-gateway",
    ]);
    for (const key of Object.values(P1CapabilityKeys)) {
      expect(CapabilityKey.safeParse(key).success).toBe(true);
    }
  });
});
