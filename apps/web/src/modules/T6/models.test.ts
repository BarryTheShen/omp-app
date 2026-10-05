import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  decodeLearnArgs,
  decodeManageSkillArgs,
  decodeMemoryEditArgs,
  decodeMemoryRecallArgs,
  decodeMemoryReflectArgs,
  decodeMemoryRetainArgs,
  mapT6Failure,
  normalizeLearn,
  normalizeManageSkill,
  normalizeMemoryEdit,
  normalizeRecall,
  normalizeReflect,
  normalizeRetain,
} from "./models";

describe("T6 tolerant memory models", () => {
  test("decodes recall/reflect arguments and maps no-match/no-information", () => {
    expect(decodeMemoryRecallArgs({ query: "prior decision" }).ok).toBe(true);
    expect(decodeMemoryReflectArgs({ query: "what changed?", context: "release" }).ok).toBe(true);
    expect(
      normalizeRecall(
        { query: "prior" },
        { content: [{ type: "text", text: "No relevant memories found." }], details: {} },
      ),
    ).toMatchObject({
      query: "prior",
      count: 0,
      noMatch: true,
    });
    expect(
      normalizeReflect(
        { query: "what?" },
        {
          content: [{ type: "text", text: "No relevant information found to reflect on." }],
          details: {},
        },
      ),
    ).toMatchObject({
      noInformation: true,
    });
  });

  test("decodes retain and preserves only safe bounded render fields", () => {
    expect(
      decodeMemoryRetainArgs({ items: [{ content: "remember this", scope: "project" }] }).ok,
    ).toBe(true);
    expect(
      normalizeRetain(
        { items: [{ content: "remember this" }] },
        { content: [], details: { count: 1, stored: 1 } },
      ),
    ).toMatchObject({
      count: 1,
      status: "stored",
      items: [{ content: "remember this" }],
    });
    expect(
      normalizeRetain({ items: [{ content: "memory" }] }, { details: { queued: 1 } }).status,
    ).toBe("queued");
  });

  test("decodes learn/manage_skill/memory_edit args and statuses", () => {
    expect(
      decodeLearnArgs({ memory: "lesson", skill: { action: "create", name: "lesson" } }).ok,
    ).toBe(true);
    expect(decodeManageSkillArgs({ action: "delete", name: "old-skill" }).ok).toBe(true);
    expect(decodeMemoryEditArgs({ op: "invalidate", id: "memory-1" }).ok).toBe(true);
    expect(
      normalizeLearn(
        { memory: "lesson" },
        { content: [{ type: "text", text: "Lesson stored." }], details: { skill: null } },
      ).skillStatus,
    ).toBe("stored");
    expect(
      normalizeManageSkill(
        { action: "delete", name: "old" },
        {
          content: [{ type: "text", text: "Deleted managed skill" }],
          details: { action: "delete", name: "old" },
        },
      ).status,
    ).toBe("deleted");
    expect(
      normalizeMemoryEdit(
        { op: "forget", id: "m1" },
        {
          content: [{ type: "text", text: "Memory m1 forgotten." }],
          details: { status: "forgotten", id: "m1" },
        },
      ),
    ).toMatchObject({ operation: "forget", status: "forgotten" });
  });

  test("malformed details become a visible malformed model instead of throwing", () => {
    const recalled = normalizeRecall({ query: "q" }, { content: [{ nope: true }], details: "bad" });
    expect(recalled.malformed).toBe(true);
    expect(recalled.raw).toEqual({ content: [{ nope: true }], details: "bad" });
    expect(normalizeRetain({ items: "bad" }, { details: "bad" }).malformed).toBe(true);
  });

  test("bounds private memory text and never echoes unknown failures into AppFailure", () => {
    const long = "x".repeat(5_000);
    expect(
      normalizeReflect({ query: "q" }, { content: [{ type: "text", text: long }], details: {} })
        .answer.truncated,
    ).toBe(true);
    expect(
      mapT6Failure(new Error("private memory content"), "recall").appError.message,
    ).not.toContain("private memory");
    const original = new AppFailure({ code: "permission", message: "blocked", retryable: false });
    expect(mapT6Failure(original, "recall")).toBe(original);
  });
});
