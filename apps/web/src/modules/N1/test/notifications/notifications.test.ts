import type { OmpWire, RpcSessionEvent } from "@omp-app/contracts";
import { AppFailure, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "../../../R0/store";
import type { Notification } from "../../contract";
import {
  MAX_NOTIFICATIONS_PER_THREAD,
  NotificationBus,
  NotificationProjector,
} from "../../notifications";

const threadId = ThreadIdSchema.parse("thread-n1-notifications");

function publishRuntimeEvent(
  store: OmpRuntimeStore,
  event: Record<string, unknown>,
  sequence: number,
) {
  store.ingest({ kind: "omp", event } as unknown as RpcSessionEvent, sequence);
}

function model(id: string, name: string): OmpWire.ModelInfo {
  return {
    id,
    name,
    api: "openai-completions",
    provider: "provider",
    baseUrl: "https://provider.example",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function notice(overrides: Partial<Notification> = {}): Notification {
  return {
    threadId,
    dedupeKey: "notice",
    severity: "info",
    placement: "toast",
    message: "hello",
    live: "polite",
    focus: "preserve",
    ...overrides,
  };
}

describe("NotificationBus", () => {
  test("replaces by thread and dedupe key, ignores exact reconnect replay, and clears safely", () => {
    const bus = new NotificationBus();
    const updates: number[] = [];
    bus.subscribe((snapshot) => updates.push(snapshot.revision));

    expect(bus.publish(notice())).toBe("published");
    expect(bus.publish(notice())).toBe("deduplicated");
    expect(
      bus.publish(
        notice({
          message: "changed",
          severity: "warning",
          live: "polite",
        }),
      ),
    ).toBe("replaced");
    expect(bus.get(threadId, "notice")?.message).toBe("changed");
    expect(bus.getSnapshot().notifications).toHaveLength(1);
    expect(Object.isFrozen(bus.getSnapshot())).toBe(true);
    expect(Object.isFrozen(bus.getSnapshot().notifications)).toBe(true);
    expect(updates).toHaveLength(2);

    const otherThread = ThreadIdSchema.parse("thread-other");
    bus.publish(notice({ threadId: otherThread, dedupeKey: "other" }));
    expect(bus.clearForThread(threadId)).toBe(1);
    expect(bus.getSnapshot().notifications).toHaveLength(1);
    expect(bus.dismiss(otherThread, "other")).toBe(true);
    expect(bus.dismiss(otherThread, "other")).toBe(false);
  });

  test("rejects malformed notifications through the typed AppFailure boundary", () => {
    const bus = new NotificationBus();
    expect(() => bus.publish({ ...notice(), focus: "move" } as never)).toThrow(AppFailure);
  });
  test("expires notifications at their deadline and bounds each thread", () => {
    const bus = new NotificationBus();
    bus.publish(notice({ dedupeKey: "expiring", expiresAt: 100 }));
    expect(bus.expire(99)).toBe(0);
    expect(bus.expire(100)).toBe(1);
    expect(bus.get(threadId, "expiring")).toBeUndefined();

    for (let index = 0; index < MAX_NOTIFICATIONS_PER_THREAD + 10; index += 1) {
      bus.publish(notice({ dedupeKey: `notice-${index}`, message: `notice ${index}` }));
    }
    expect(
      bus.getSnapshot().notifications.filter((notification) => notification.threadId === threadId),
    ).toHaveLength(MAX_NOTIFICATIONS_PER_THREAD);
    expect(bus.get(threadId, "notice-0")).toBeUndefined();
    expect(bus.get(threadId, `notice-${MAX_NOTIFICATIONS_PER_THREAD + 9}`)).toBeDefined();
  });

  test("keeps at most 256 notifications per thread after 20,000 notices", () => {
    const bus = new NotificationBus();
    for (let index = 0; index < 20_000; index += 1) {
      bus.publish(notice({ dedupeKey: `notice-${index}`, message: `notice ${index}` }));
    }
    const kept = bus
      .getSnapshot()
      .notifications.filter((notification) => notification.threadId === threadId);
    expect(kept.length).toBeLessThanOrEqual(MAX_NOTIFICATIONS_PER_THREAD);
    expect(kept.at(-1)?.dedupeKey).toBe("notice-19999");
    expect(bus.get(threadId, "notice-0")).toBeUndefined();
  });
});

describe("NotificationProjector", () => {
  test("projects retries as transient banners and keeps only retry failures in the transcript", () => {
    const store = new OmpRuntimeStore({ threadId });
    const transcript: Notification[] = [];
    const projector = new NotificationProjector({
      source: store,
      events: store,
      now: () => 1_000,
      transcript: { upsert: (notification) => transcript.push(notification) },
    });

    publishRuntimeEvent(
      store,
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1_500,
        errorMessage: "temporary provider failure",
      },
      1,
    );
    expect(projector.getBus().get(threadId, "retry:active")).toMatchObject({
      severity: "warning",
      placement: "banner",
      live: "polite",
      message: "Retrying (1/3) in 1.5s: temporary provider failure",
    });
    expect(transcript).toHaveLength(0);

    publishRuntimeEvent(
      store,
      {
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "provider down",
      },
      2,
    );
    expect(projector.getBus().get(threadId, "retry:active")).toBeUndefined();
    expect(projector.getBus().get(threadId, "retry:result")).toMatchObject({
      severity: "error",
      placement: "transcript",
      live: "assertive",
      message: "Retry failed after 3 attempts: provider down",
    });
    expect(transcript).toHaveLength(1);

    publishRuntimeEvent(
      store,
      { type: "retry_fallback_applied", from: "provider/a", to: "provider/b", role: "main" },
      3,
    );
    const appliedFallback = projector
      .getBus()
      .getSnapshot()
      .notifications.find((notification) => notification.source === "omp.fallback");
    expect(appliedFallback?.message).toContain("Fallback:");
    publishRuntimeEvent(
      store,
      { type: "retry_fallback_succeeded", model: "provider/b", role: "main" },
      4,
    );
    const fallback = projector
      .getBus()
      .getSnapshot()
      .notifications.find((notification) => notification.source === "omp.fallback");
    expect(fallback).toMatchObject({ severity: "success", live: "off" });
    expect(fallback?.message).toBe("Fallback succeeded on provider/b");

    projector.dispose();
  });
  test("ignores unrelated omp events without creating projection errors or revisions", () => {
    const store = new OmpRuntimeStore({ threadId });
    const projector = new NotificationProjector({ source: store, events: store });
    const initialRevision = projector.getSnapshot().revision;

    publishRuntimeEvent(store, { type: "agent_start" }, 1);
    publishRuntimeEvent(store, { type: "agent_end" }, 2);

    expect(projector.getBus().getSnapshot().notifications).toEqual([]);
    expect(projector.getSnapshot().error).toBeNull();
    expect(projector.getSnapshot().revision).toBe(initialRevision);
    projector.dispose();
  });

  test("clears malformed-event errors and keeps repeated notices distinct by sequence", () => {
    const store = new OmpRuntimeStore({ threadId });
    const projector = new NotificationProjector({ source: store, events: store });

    publishRuntimeEvent(store, { type: "auto_retry_start" }, 1);
    expect(projector.getSnapshot().error?.code).toBe("invalid_args");
    expect(projector.getBus().get(threadId, "projection:error")).toBeDefined();
    publishRuntimeEvent(store, { type: "agent_start" }, 2);
    expect(projector.getSnapshot().error?.code).toBe("invalid_args");
    expect(projector.getBus().get(threadId, "projection:error")).toBeDefined();

    publishRuntimeEvent(store, { type: "notice", level: "info", message: "Build finished" }, 3);
    publishRuntimeEvent(store, { type: "notice", level: "info", message: "Build finished" }, 4);

    const notices = projector
      .getBus()
      .getSnapshot()
      .notifications.filter((item) => item.message === "Build finished");
    expect(notices).toHaveLength(2);
    expect(notices[0]?.dedupeKey).not.toBe(notices[1]?.dedupeKey);
    expect(projector.getSnapshot().error).toBeNull();
    expect(projector.getBus().get(threadId, "projection:error")).toBeUndefined();
    projector.dispose();
  });

  test("dispose clears only its thread and stops both runtime subscriptions", () => {
    const otherThreadId = ThreadIdSchema.parse("thread-other");
    const store = new OmpRuntimeStore({ threadId });
    const otherStore = new OmpRuntimeStore({ threadId: otherThreadId });
    const bus = new NotificationBus();
    const projector = new NotificationProjector({ source: store, events: store, bus });
    const otherProjector = new NotificationProjector({
      source: otherStore,
      events: otherStore,
      bus,
    });
    publishRuntimeEvent(store, { type: "notice", level: "info", message: "Before dispose" }, 1);
    publishRuntimeEvent(
      otherStore,
      { type: "notice", level: "info", message: "Keep other thread" },
      1,
    );
    expect(bus.getSnapshot().notifications).toHaveLength(2);
    const revision = projector.getSnapshot().revision;

    projector.dispose();
    expect(bus.getSnapshot().notifications).toEqual([
      expect.objectContaining({ threadId: otherThreadId, message: "Keep other thread" }),
    ]);
    store.applySessionState({ sessionName: "After dispose" });
    publishRuntimeEvent(store, { type: "notice", level: "info", message: "After dispose" }, 2);

    expect(bus.getSnapshot().notifications).toEqual([
      expect.objectContaining({ threadId: otherThreadId, message: "Keep other thread" }),
    ]);
    expect(projector.getSnapshot().revision).toBe(revision);
    otherProjector.dispose();
    expect(bus.getSnapshot().notifications).toEqual([]);
  });

  test("merges adjacent TTSR events and resets after every other Omp event", () => {
    const store = new OmpRuntimeStore({ threadId });
    const projector = new NotificationProjector({ source: store, events: store });

    publishRuntimeEvent(store, { type: "ttsr_triggered", rules: [{ name: "rules/a" }] }, 1);
    publishRuntimeEvent(store, { type: "ttsr_triggered", rules: [{ name: "rules/b" }] }, 2);
    expect(projector.getBus().get(threadId, "ttsr")?.message).toContain("rules/a");
    expect(projector.getBus().get(threadId, "ttsr")?.message).toContain("rules/b");

    publishRuntimeEvent(store, { type: "agent_start" }, 3);
    publishRuntimeEvent(store, { type: "agent_end" }, 4);
    publishRuntimeEvent(store, { type: "ttsr_triggered", rules: [{ name: "rules/c" }] }, 5);
    const reset = projector.getBus().get(threadId, "ttsr");
    expect(reset?.message).not.toContain("rules/a");
    expect(reset?.message).not.toContain("rules/b");
    expect(reset?.message).toContain("rules/c");
    projector.dispose();
  });

  test("projects R0 todo reminder snapshots without replacing canonical todo state", () => {
    const store = new OmpRuntimeStore({ threadId });
    const projector = new NotificationProjector({ source: store, events: store });
    store.applySessionState({
      todoPhases: [{ name: "Build", tasks: [{ content: "ship", status: "pending" }] }],
    });
    publishRuntimeEvent(
      store,
      {
        type: "todo_reminder",
        todos: [{ content: "ship", status: "pending" }],
        attempt: 2,
        maxAttempts: 5,
      },
      1,
    );

    const reminder = projector
      .getBus()
      .getSnapshot()
      .notifications.find((notification) => notification.source === "omp.todo");
    expect(reminder).toMatchObject({
      severity: "warning",
      placement: "transcript",
      live: "polite",
    });
    expect(reminder?.message).toContain("Todo reminder (2/5)");
    expect(reminder?.message).toContain("ship");
    expect(store.getSnapshot().todoPhases).toHaveLength(1);

    publishRuntimeEvent(
      store,
      {
        type: "todo_reminder",
        todos: [{ content: "ship", status: "pending" }],
        attempt: 2,
        maxAttempts: 5,
      },
      2,
    );
    expect(
      projector
        .getBus()
        .getSnapshot()
        .notifications.filter((notification) => notification.source === "omp.todo"),
    ).toHaveLength(1);
    projector.dispose();
  });
  test("does not announce initial session hydration as user changes", () => {
    const store = new OmpRuntimeStore({ threadId });
    const projector = new NotificationProjector({ source: store });
    store.applySessionState({
      model: model("model-a", "Model A"),
      thinkingLevel: "low",
      sessionName: "Build session",
    });
    expect(
      projector
        .getBus()
        .getSnapshot()
        .notifications.filter((notification) => notification.source === "session"),
    ).toEqual([]);

    store.applySessionState({
      model: model("model-b", "Model B"),
      thinkingLevel: "high",
      sessionName: "Renamed session",
    });
    const notices = projector
      .getBus()
      .getSnapshot()
      .notifications.filter((notification) => notification.source === "session");
    expect(notices.map((notification) => notification.dedupeKey)).toEqual([
      "session:model",
      "session:thinking",
      "session:name",
    ]);
    expect(notices.map((notification) => notification.message)).toEqual([
      "Model changed to Model B",
      "Thinking level changed to high",
      "Session renamed to Renamed session",
    ]);

    const before = projector.getBus().getSnapshot().revision;
    store.applySessionState({ contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } });
    expect(projector.getBus().getSnapshot().revision).toBe(before);
    expect(projector.getSnapshot().session.contextUsage?.percent).toBe(10);
    projector.dispose();
  });

  test("projects non-modal U4 handoffs and contains projection failures", () => {
    const store = new OmpRuntimeStore({ threadId });
    const editor: Array<{ text: string; context: string }> = [];
    const projector = new NotificationProjector({
      source: store,
      onEditorText: (text, context) => editor.push({ text, context: String(context.threadId) }),
    });

    projector.present(
      { kind: "notify", message: "Extension finished", notifyType: "warning" },
      { threadId },
    );
    expect(projector.getBus().getSnapshot().notifications[0]).toMatchObject({
      severity: "warning",
      placement: "toast",
      live: "polite",
      focus: "preserve",
    });
    projector.present(
      { kind: "setStatus", statusKey: "build", statusText: "Running" },
      { threadId },
    );
    projector.present(
      {
        kind: "setWidget",
        widgetKey: "widget",
        widgetLines: Array.from({ length: 12 }, (_, i) => `line-${i}`),
      },
      { threadId },
    );
    projector.present({ kind: "setTitle", title: "Safe title" }, { threadId });
    projector.present({ kind: "set_editor_text", text: "draft" }, { threadId });

    expect(projector.getSnapshot().statuses).toEqual([
      { statusKey: "build", statusText: "Running" },
    ]);
    expect(projector.getSnapshot().widgets[0]).toMatchObject({
      lines: [
        "line-0",
        "line-1",
        "line-2",
        "line-3",
        "line-4",
        "line-5",
        "line-6",
        "line-7",
        "line-8",
        "… 3 more",
      ],
    });
    expect(projector.getSnapshot().title).toBe("Safe title");
    expect(editor).toEqual([{ text: "draft", context: String(threadId) }]);

    expect(() => projector.present({ kind: "setTitle", title: " " }, { threadId })).not.toThrow();
    expect(projector.getSnapshot().error?.code).toBe("invalid_args");
    expect(projector.getBus().get(threadId, "projection:error")).toMatchObject({
      severity: "error",
      placement: "banner",
    });
    projector.present(
      { kind: "notify", message: "Extension recovered", notifyType: "info" },
      { threadId },
    );
    expect(projector.getSnapshot().error).toBeNull();
    expect(projector.getBus().get(threadId, "projection:error")).toBeUndefined();
    projector.dispose();
  });

  test("reports editor handoffs as unavailable when no composer host is attached", () => {
    const projector = new NotificationProjector({ source: new OmpRuntimeStore({ threadId }) });
    projector.present({ kind: "set_editor_text", text: "draft" }, { threadId });

    expect(projector.getSnapshot().error?.code).toBe("unavailable");
    expect(projector.getBus().get(threadId, "projection:error")).toMatchObject({
      severity: "error",
      placement: "banner",
    });
    projector.dispose();
  });

  test("removes a widget when omp sends an empty widget handoff", () => {
    const store = new OmpRuntimeStore({ threadId });
    const projector = new NotificationProjector({ source: store });
    projector.present(
      { kind: "setWidget", widgetKey: "component", widgetLines: ["ready"] },
      { threadId },
    );
    expect(projector.getSnapshot().widgets).toEqual([
      { widgetKey: "component", placement: "aboveEditor", lines: ["ready"] },
    ]);

    projector.present({ kind: "setWidget", widgetKey: "component" }, { threadId });
    expect(projector.getSnapshot().widgets).toEqual([]);
    expect(projector.getSnapshot().error).toBeNull();
    projector.dispose();
  });
  test("clears retry state after a refetch and keeps projection on its store thread", () => {
    const store = new OmpRuntimeStore({ threadId });
    const projector = new NotificationProjector({ source: store, events: store });
    publishRuntimeEvent(
      store,
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1_000,
        errorMessage: "temporary",
      },
      1,
    );
    expect(projector.getBus().get(threadId, "retry:active")).toBeDefined();

    store.ingest({ kind: "process", status: "ready" } as RpcSessionEvent, 3);
    store.resetSequence(3);
    expect(projector.getBus().get(threadId, "retry:active")).toBeUndefined();

    publishRuntimeEvent(store, { type: "notice", level: "error", message: "already shown" }, 4);
    expect(projector.getBus().getSnapshot().notifications).not.toContainEqual(
      expect.objectContaining({ message: "already shown" }),
    );
    const otherThread = ThreadIdSchema.parse("thread-other");
    projector.present(
      { kind: "notify", message: "on the right thread", notifyType: "info" },
      { threadId: otherThread },
    );
    expect(
      projector
        .getBus()
        .getSnapshot()
        .notifications.find((notification) => notification.message === "on the right thread")
        ?.threadId,
    ).toBe(threadId);
    projector.dispose();
  });

  test("a replayed omp notice is shown but not read aloud again, at any level; a new one is read politely", () => {
    const store = new OmpRuntimeStore({ threadId });
    const projector = new NotificationProjector({ source: store, events: store });
    const omp = (message: string, level: "info" | "warning") =>
      ({ kind: "omp", event: { type: "notice", level, message } }) as unknown as RpcSessionEvent;
    store.ingest(omp("Replayed info", "info"), 1, true);
    store.ingest(omp("Replayed warning", "warning"), 2, true);
    store.ingest(omp("New warning", "warning"), 3);
    const live = Object.fromEntries(
      projector
        .getBus()
        .getSnapshot()
        .notifications.map((item) => [item.message, item.live]),
    );
    expect(live).toEqual({
      "Replayed info": "off",
      "Replayed warning": "off",
      "New warning": "polite",
    });
    projector.dispose();
  });

  test("a replayed notice shows, but is not live, so it is not read aloud again", () => {
    const store = new OmpRuntimeStore({ threadId });
    const projector = new NotificationProjector({ source: store });
    projector.present(
      { kind: "notify", message: "Replayed notice", notifyType: "error" },
      { threadId, replayed: true },
    );
    projector.present({ kind: "notify", message: "New notice", notifyType: "error" }, { threadId });
    const live = Object.fromEntries(
      projector
        .getBus()
        .getSnapshot()
        .notifications.map((notification) => [notification.message, notification.live]),
    );
    expect(live).toEqual({ "Replayed notice": "off", "New notice": "assertive" });
    projector.dispose();
  });
});
