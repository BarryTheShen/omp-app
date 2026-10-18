import { type Descriptor, INVENTORY, type InventoryId, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { PresentationHandoffSchema } from "../../../U4/contract";
import {
  N1RuntimeEventSchema,
  Notification,
  TodoAutoClearSchema,
  TodoReminderSchema,
} from "../../contract";
import { N1_DESCRIPTORS, N2_STATUS_DESCRIPTORS } from "../../descriptors";
import {
  assertN1FixturesAreScrubbed,
  N1_DIRTY_STATUS_INPUTS,
  N1_FIXTURE_THREAD_ID,
  N1_LONG_PATH_STATUS_INPUTS,
  N1_NO_REPOSITORY_STATUS_INPUTS,
  N1_NOTIFICATION_FIXTURES,
  N1_PRESENTATION_HANDOFF_FIXTURES,
  N1_RUNTIME_EVENT_FIXTURES,
  N1_STATUS_INPUTS,
  N1_TODO_REMINDER_FIXTURE,
  N1_UNBORN_REPOSITORY_STATUS_INPUTS,
} from "../../fixtures";
import { NotificationBus } from "../../notifications";
import { buildStatusChips } from "../../status/model";

const N1_GROUPS: Record<string, true> = { N1: true, N2: true };
const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("N1.5 scrubbed fixture and descriptor gate", () => {
  test("keeps every N1/N2 inventory row covered exactly once", () => {
    const rows = INVENTORY.filter((item) => N1_GROUPS[item.group] === true).map((item) => item.id);
    const covered = N1_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);

    expect(rows).toHaveLength(27);
    expect(sorted(covered)).toEqual(sorted(rows));
    expect(new Set(covered).size).toBe(covered.length);
    expect(validateRegistry(N1_DESCRIPTORS)).toEqual([]);
  });

  test("keeps descriptor capability gates explicit for host, roster and collaboration data", () => {
    const byRow = new Map<InventoryId, Descriptor>();
    for (const descriptor of N1_DESCRIPTORS) {
      for (const row of descriptor.covers) byRow.set(row, descriptor);
    }

    expect(byRow.get("N2.hostname")?.requires).toEqual(["host.metadata"]);
    expect(byRow.get("N2.path")?.requires).toEqual(["host.workspace-state"]);
    expect(byRow.get("N2.git")?.requires).toEqual(["host.git-state"]);
    expect(byRow.get("N2.pr")?.requires).toEqual(["host.github-refs"]);
    expect(byRow.get("N2.subagents")?.requires).toEqual(["omp.subagent-events"]);
    expect(byRow.get("N2.collab")?.requires).toEqual(["upstream.collaboration"]);
    expect(byRow.get("N2.pi")?.requires).toEqual([]);
  });

  test("parses every runtime event fixture and rejects unknown events", () => {
    for (const event of N1_RUNTIME_EVENT_FIXTURES) {
      expect(N1RuntimeEventSchema.parse(event)).toEqual(event);
    }
    expect(TodoReminderSchema.parse(N1_TODO_REMINDER_FIXTURE)).toMatchObject({
      type: "todo_reminder",
      attempt: 2,
      maxAttempts: 4,
    });
    expect(TodoAutoClearSchema.parse({ type: "todo_auto_clear" })).toEqual({
      type: "todo_auto_clear",
    });
    expect(N1RuntimeEventSchema.safeParse({ type: "unexpected" }).success).toBe(false);
  });

  test("covers all six non-modal U4 handoffs without storing an authorization secret", () => {
    const kinds = N1_PRESENTATION_HANDOFF_FIXTURES.map((handoff) => handoff.kind);
    expect(kinds).toEqual([
      "notify",
      "setStatus",
      "setWidget",
      "setTitle",
      "set_editor_text",
      "open_url",
    ]);
    for (const handoff of N1_PRESENTATION_HANDOFF_FIXTURES) {
      expect(PresentationHandoffSchema.parse(handoff)).toEqual(handoff);
    }
    const url = N1_PRESENTATION_HANDOFF_FIXTURES.find((handoff) => handoff.kind === "open_url");
    expect(url?.kind).toBe("open_url");
    if (url?.kind === "open_url") expect(url.url).not.toContain("token");
  });

  test("keeps all fixture values scrubbed and safe for logs", () => {
    expect(assertN1FixturesAreScrubbed()).toEqual([]);
    const serialized = JSON.stringify({ N1_NOTIFICATION_FIXTURES, N1_STATUS_INPUTS });
    expect(serialized).not.toMatch(
      /Bearer\s+\w+|\/home\/|\/Users\/|\/root\/|\/tmp\/|@[\w.-]+\.[A-Za-z]{2,}/,
    );
    for (const notice of N1_NOTIFICATION_FIXTURES)
      expect(Notification.parse(notice).focus).toBe("preserve");
  });

  test("replaces duplicate stream notices and does not restore a retired replay", () => {
    const retired = new Set<string>();
    const bus = new NotificationBus({
      retired: {
        has: (threadId, dedupeKey) => retired.has(`${threadId}:${dedupeKey}`),
        remember: (threadId, dedupeKey) => retired.add(`${threadId}:${dedupeKey}`),
      },
    });
    const initial = N1_NOTIFICATION_FIXTURES[0];
    if (!initial) throw new Error("missing retry fixture");
    const stream = {
      ...initial,
      dedupeKey: "session:notice:1:warning",
      placement: "toast" as const,
    };
    expect(bus.publish(initial)).toBe("published");
    expect(bus.publish(initial)).toBe("deduplicated");
    expect(bus.publish({ ...initial, message: "Retrying request (attempt 2 of 3)" })).toBe(
      "replaced",
    );
    expect(bus.publish(stream)).toBe("published");
    expect(bus.retire(N1_FIXTURE_THREAD_ID, stream.dedupeKey)).toBe(true);
    expect(bus.publish(stream)).toBe("deduplicated");
  });

  test("keeps one stable status row per N2 descriptor across clean, dirty, no-repository and long-path states", () => {
    const expected = sorted(N2_STATUS_DESCRIPTORS.flatMap((descriptor) => descriptor.covers));
    for (const inputs of [
      N1_STATUS_INPUTS,
      N1_DIRTY_STATUS_INPUTS,
      N1_NO_REPOSITORY_STATUS_INPUTS,
      N1_UNBORN_REPOSITORY_STATUS_INPUTS,
      N1_LONG_PATH_STATUS_INPUTS,
    ]) {
      const chips = buildStatusChips(inputs);
      expect(sorted(chips.map((chip) => chip.segment.id))).toEqual(expected);
      expect(new Set(chips.map((chip) => chip.segment.id)).size).toBe(chips.length);
      expect(chips.every((chip) => chip.segment.accessibleLabel.length > 0)).toBe(true);
    }
    const unavailable = buildStatusChips(N1_NO_REPOSITORY_STATUS_INPUTS);
    const gitUnavailable = unavailable.find((chip) => chip.segment.id === "N2.git");
    expect(gitUnavailable?.segment.value).toEqual({
      state: "unavailable",
      reason: "This folder is not in a git repository.",
    });
    const unborn = buildStatusChips(N1_UNBORN_REPOSITORY_STATUS_INPUTS);
    const unbornGit = unborn.find((chip) => chip.segment.id === "N2.git");
    expect(unbornGit?.segment.value).toEqual({
      state: "unavailable",
      reason: "This repository has no commits yet.",
    });
    expect(unavailable.find((chip) => chip.segment.id === "N2.collab")?.segment.value.state).toBe(
      "unavailable",
    );
  });
});
