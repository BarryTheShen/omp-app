import { describe, expect, test } from "bun:test";
import { AppFailure } from "@omp-app/contracts";
import type { CommandParserContext } from "./gateway";
import { parseMemoryReply } from "./memory-parsers";

function reply(command: string, text: string, agentInvoked = false): CommandParserContext {
  return {
    command,
    agentInvoked,
    outputs: [{ text }],
    sessionUpdates: [],
    configUpdates: [],
  };
}

const MM_UNAVAILABLE =
  "Mental-model maintenance via /memory mm is unsupported in ACP mode; use the hindsight HTTP API directly.";

describe("/memory typed parser", () => {
  test("parses exact clear/reset and enqueue/rebuild replies without inventing counts", () => {
    expect(parseMemoryReply(reply("/memory clear", "Memory cleared."))).toEqual({
      operation: "clear",
      outcome: "completed",
    });
    expect(parseMemoryReply(reply("/memory reset", "Memory cleared."))).toEqual({
      operation: "reset",
      outcome: "completed",
    });
    expect(parseMemoryReply(reply("/memory enqueue", "Memory consolidation enqueued."))).toEqual({
      operation: "enqueue",
      outcome: "completed",
    });
    expect(parseMemoryReply(reply("/memory rebuild", "Memory consolidation enqueued."))).toEqual({
      operation: "rebuild",
      outcome: "completed",
    });
  });

  test("keeps view, stats and diagnose payloads typed without classifying their backend text", () => {
    expect(parseMemoryReply(reply("/memory view", "Memory payload is empty."))).toEqual({
      operation: "view",
      outcome: "completed",
      text: "Memory payload is empty.",
    });
    expect(parseMemoryReply(reply("/memory stats", "entries: 3\nbackend: local"))).toEqual({
      operation: "stats",
      outcome: "completed",
      text: "entries: 3\nbackend: local",
    });
    expect(parseMemoryReply(reply("/memory diagnose", "No memory problems found."))).toEqual({
      operation: "diagnose",
      outcome: "completed",
      text: "No memory problems found.",
    });
  });

  test("classifies backend-unavailable stats and diagnose replies", () => {
    expect(
      parseMemoryReply(reply("/memory stats", "Memory backend is off — there is nothing to show.")),
    ).toEqual({
      operation: "stats",
      outcome: "unavailable",
      backend: "off",
      reason: "backend-off",
    });
    expect(
      parseMemoryReply(
        reply("/memory diagnose", "Memory diagnose is not available for the local backend."),
      ),
    ).toEqual({
      operation: "diagnose",
      outcome: "unavailable",
      backend: "local",
      reason: "backend-unavailable",
    });
  });

  test("classifies every ACP mental-model operation as unavailable", () => {
    for (const operation of [
      "list",
      "show abc",
      "history abc",
      "refresh",
      "reload",
      "seed",
      "delete abc",
    ]) {
      const command = `/memory mm ${operation}`;
      const parsed = parseMemoryReply(reply(command, MM_UNAVAILABLE));
      expect(parsed.outcome).toBe("unavailable");
      expect(parsed.reason).toBe("unsupported-acp");
    }
  });

  test("rejects invented counts, malformed output, model invocation and wrong commands", () => {
    expect(() => parseMemoryReply(reply("/memory clear", "Deleted 2 entries."))).toThrow(
      AppFailure,
    );
    expect(() => parseMemoryReply(reply("/memory enqueue", "Memory enqueue complete."))).toThrow(
      AppFailure,
    );
    expect(() => parseMemoryReply(reply("/memory clear", "Memory cleared.", true))).toThrow(
      AppFailure,
    );
    expect(() => parseMemoryReply(reply("/memory reset", "Memory cleared\nagain"))).toThrow(
      AppFailure,
    );
    expect(() =>
      parseMemoryReply({ ...reply("/tools", "Memory cleared."), command: "/tools" }),
    ).toThrow(AppFailure);
    expect(() => parseMemoryReply(reply("/memory mm list", "1. daily-notes\n2. goals"))).toThrow(
      AppFailure,
    );
    expect(() => parseMemoryReply(reply("/memory view", "x".repeat(200_001)))).toThrow(
      "too large to display safely",
    );
  });
});
