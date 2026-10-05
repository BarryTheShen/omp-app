import { ThreadId, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  AutoRetryEndSchema,
  AutoRetryStartSchema,
  N1RuntimeEventSchema,
  Notification,
  StatusSegment,
  TodoReminderSchema,
  TtsrTriggeredSchema,
} from "../../contract";
import { N1_DESCRIPTORS, N1_NOTICE_DESCRIPTORS, N2_STATUS_DESCRIPTORS } from "../../descriptors";

const EXPECTED_COVERS = [
  "N1.ttsr-rewind-notification",
  "N1.automatic-retry-loader-result",
  "N1.extension-oauth-open-url-handoff",
  "N1.extension-editor-text-update",
  "N1.extension-notify",
  "N1.extension-status-entry",
  "N1.extension-terminal-title",
  "N1.extension-widget-above-below-editor",
  "N1.extension-tool-runtime-error",
  "N1.new-version-notification",
  "N1.pinned-provider-error-banner",
  "N1.retry-fallback-notification",
  "N1.session-notice",
  "N1.todo-reminder-notification",
  "N2.collab",
  "N2.git",
  "N2.hostname",
  "N2.mode",
  "N2.model",
  "N2.path",
  "N2.pi",
  "N2.pr",
  "N2.session",
  "N2.session-name",
  "N2.subagents",
  "N2.time",
  "N2.time-spent",
] as const;

describe("N1 typed payloads", () => {
  test("accepts the runtime event subset and preserves open extension rule fields", () => {
    expect(
      AutoRetryStartSchema.parse({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 100,
        errorMessage: "temporary provider failure",
      }),
    ).toMatchObject({ attempt: 1 });
    expect(
      AutoRetryEndSchema.parse({
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        retryErrors: [{ providerCode: "opaque", nested: { value: true } }],
      }).retryErrors,
    ).toHaveLength(1);
    expect(
      N1RuntimeEventSchema.parse({
        type: "notice",
        level: "warning",
        message: "waiting",
        source: "session",
      }).type,
    ).toBe("notice");
    expect(
      TtsrTriggeredSchema.parse({
        type: "ttsr_triggered",
        rules: [{ name: "rule", extensionField: { safe: true } }],
      }).rules[0],
    ).toMatchObject({ name: "rule" });
  });

  test("bounds and discriminates todo reminder payloads", () => {
    expect(
      TodoReminderSchema.parse({
        type: "todo_reminder",
        todos: [{ content: "finish", status: "in_progress", notes: ["later"] }],
        attempt: 1,
        maxAttempts: 2,
      }).todos[0]?.status,
    ).toBe("in_progress");
    expect(N1RuntimeEventSchema.safeParse({ type: "todo_auto_clear" }).success).toBe(true);
    expect(N1RuntimeEventSchema.safeParse({ type: "unrelated_event" }).success).toBe(false);
    expect(StatusSegment.safeParse({ id: "mode", label: "Mode" }).success).toBe(false);
  });

  test("keeps notice data immutable and focus-safe at the boundary", () => {
    const result = Notification.parse({
      threadId: ThreadId.parse("thread-n1"),
      dedupeKey: "retry",
      severity: "warning",
      placement: "banner",
      message: "Retrying",
      live: "polite",
      focus: "preserve",
    });
    expect(result.focus).toBe("preserve");
    expect(result.live).toBe("polite");
  });
});

describe("N1 descriptor coverage", () => {
  test("covers exactly all fourteen N1 and thirteen N2 rows once", () => {
    expect(N1_NOTICE_DESCRIPTORS).toHaveLength(14);
    expect(N2_STATUS_DESCRIPTORS).toHaveLength(13);
    const covers = N1_DESCRIPTORS.flatMap((descriptor) => descriptor.covers).sort();
    expect(covers).toEqual([...EXPECTED_COVERS].sort());
    expect(new Set(covers).size).toBe(covers.length);
  });

  test("passes C0 validation with owner-prefixed IDs", () => {
    expect(validateRegistry(N1_DESCRIPTORS)).toEqual([]);
    expect(N1_DESCRIPTORS.every((descriptor) => descriptor.id.startsWith("N1."))).toBe(true);
  });

  test("uses typed capability gates for host and upstream status data", () => {
    const byId = new Map(N1_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));
    expect(byId.get("N1.git")?.requires).toEqual(["host.git-state"]);
    expect(byId.get("N1.hostname")?.requires).toEqual(["host.metadata"]);
    expect(byId.get("N1.path")?.requires).toEqual(["host.workspace-state"]);
    expect(byId.get("N1.pr")?.requires).toEqual(["host.github-refs"]);
    expect(byId.get("N1.collab")?.requires).toEqual(["upstream.collaboration"]);
    expect(byId.get("N1.subagents")?.requires).toEqual(["omp.subagent-events"]);
  });
});
