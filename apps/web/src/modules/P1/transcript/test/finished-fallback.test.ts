import { AppFailure, SessionFilePath, SubagentId, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { SubagentClient } from "@/modules/P1/client";
import {
  type AgentRef,
  AgentRefSchema,
  type SubagentTranscriptPage,
  SubagentTranscriptPageSchema,
} from "@/modules/P1/contract";
import { createFocusedAgentRuntime, createNestedTranscriptSource } from "../source";

const threadId = ThreadId.parse("thread-fallback");
const file = SessionFilePath.parse("/workspace/.omp/sessions/main/Done.jsonl");

function agentRef(status: "running" | "completed"): AgentRef {
  return AgentRefSchema.parse({
    id: SubagentId.parse("Done"),
    index: 0,
    agent: "task",
    agentSource: "unknown",
    status,
    lastUpdate: 1,
    sessionFile: file,
    threadId,
  });
}

/** omp, after a reload, no longer knows the finished worker, so its live read fails. */
function unknownToOmp(): SubagentClient {
  return {
    getRoster: async () => [],
    readTranscript: async () => {
      throw new AppFailure({
        code: "not_found",
        message: "Unknown subagent or session file unavailable: Done",
        retryable: false,
      });
    },
    cancel: async () => ({ cancelled: true as const }),
    steer: async () => {},
    setSubscriptionLevel: async (level) => level,
    acquireSubscription: async (level) => ({ level, release: async () => {} }),
    subscribeNotifications: () => () => {},
    dispose: async () => {},
  };
}

function diskPage(): SubagentTranscriptPage {
  return SubagentTranscriptPageSchema.parse({
    sessionFile: file,
    fromByte: 0,
    nextByte: 10,
    reset: false,
    entries: [],
    messages: [],
  });
}

describe("a finished worker's transcript after a reload", () => {
  test("when omp no longer knows a finished worker, its file is read from the cursor", async () => {
    const reads: { file: string; fromByte: number | undefined }[] = [];
    const source = createNestedTranscriptSource({
      agent: agentRef("completed"),
      client: unknownToOmp(),
      finished: {
        read: async (sessionFile, fromByte) => {
          reads.push({ file: sessionFile, fromByte });
          return diskPage();
        },
      },
    });
    await expect(source.read({ fromByte: 0 })).resolves.toMatchObject({ nextByte: 10 });
    expect(reads).toEqual([{ file, fromByte: 0 }]);
  });

  test("the focused view of a finished worker reads its file too", async () => {
    const source = createFocusedAgentRuntime({
      agent: agentRef("completed"),
      client: unknownToOmp(),
      finished: { read: async () => diskPage() },
    });
    await expect(source.read()).resolves.toMatchObject({ nextByte: 10 });
  });

  test("a running worker's failed live read is not replaced by its file", async () => {
    const source = createNestedTranscriptSource({
      agent: agentRef("running"),
      client: unknownToOmp(),
      finished: { read: async () => diskPage() },
    });
    await expect(source.read()).rejects.toMatchObject({ appError: { code: "not_found" } });
  });

  test("without a file reader, a finished worker's failed live read still fails", async () => {
    const source = createNestedTranscriptSource({
      agent: agentRef("completed"),
      client: unknownToOmp(),
    });
    await expect(source.read()).rejects.toMatchObject({ appError: { code: "not_found" } });
  });
});
