import type { OmpWire, RpcSessionEvent, UiRequestId } from "@omp-app/contracts";
import { AppFailure, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "../../../R0/store";
import type { Notification } from "../../contract";
import {
  NotificationBus,
  NotificationProjector,
  type NotificationRuntimeEvent,
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

class NormalizedEvents {
  private readonly listeners = new Set<(event: RpcSessionEvent, seq: number) => void>();

  public subscribe(listener: (event: RpcSessionEvent, seq: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public emit(event: NotificationRuntimeEvent, seq: number): void {
    const envelope = { kind: "omp", event } as unknown as RpcSessionEvent;
    for (const listener of this.listeners) listener(envelope, seq);
  }
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
});

describe("NotificationProjector", () => {
  test("projects retry lifecycle and fallback replacement with severity and politeness", () => {
    const store = new OmpRuntimeStore({ threadId });
    const events = new NormalizedEvents();
    const transcript: Notification[] = [];
    const projector = new NotificationProjector({
      source: store,
      events,
      now: () => 1_000,
      transcript: { upsert: (notification) => transcript.push(notification) },
    });

    events.emit(
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
      placement: "transcript",
      live: "polite",
      message: "Retrying (1/3) in 1.5s: temporary provider failure",
    });
    events.emit(
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1_500,
        errorMessage: "temporary provider failure",
      },
      1,
    );
    expect(transcript).toHaveLength(1);

    events.emit(
      { type: "auto_retry_end", success: false, attempt: 3, finalError: "provider down" },
      2,
    );
    expect(projector.getBus().get(threadId, "retry:active")).toBeUndefined();
    expect(projector.getBus().get(threadId, "retry:result")).toMatchObject({
      severity: "error",
      live: "assertive",
      message: "Retry failed after 3 attempts: provider down",
    });

    events.emit(
      { type: "retry_fallback_applied", from: "provider/a", to: "provider/b", role: "main" },
      3,
    );
    const appliedFallback = projector
      .getBus()
      .getSnapshot()
      .notifications.find((notification) => notification.source === "omp.fallback");
    expect(appliedFallback?.message).toContain("Fallback:");
    events.emit({ type: "retry_fallback_succeeded", model: "provider/b", role: "main" }, 4);
    const fallback = projector
      .getBus()
      .getSnapshot()
      .notifications.find((notification) => notification.source === "omp.fallback");
    expect(fallback).toMatchObject({ severity: "success", live: "off" });
    expect(fallback?.message).toBe("Fallback succeeded on provider/b");

    projector.dispose();
  });

  test("merges consecutive TTSR rules and resets the merge after another event", () => {
    const store = new OmpRuntimeStore({ threadId });
    const projector = new NotificationProjector({ source: store });

    projector.ingest(
      { type: "ttsr_triggered", rules: [{ name: "rules/a", content: "first" }] },
      { threadId, sequence: 1 },
    );
    projector.ingest(
      { type: "ttsr_triggered", rules: [{ name: "rules/b", content: "second" }] },
      { threadId, sequence: 2 },
    );
    const merged = projector.getBus().get(threadId, "ttsr");
    expect(merged?.message).toContain("rules/a");
    expect(merged?.message).toContain("rules/b");
    expect(merged?.placement).toBe("banner");

    projector.ingest(
      {
        type: "notice",
        level: "info",
        message: "turn continues",
      },
      { threadId, sequence: 3 },
    );
    projector.ingest(
      { type: "ttsr_triggered", rules: [{ name: "rules/c" }] },
      { threadId, sequence: 4 },
    );
    const reset = projector.getBus().get(threadId, "ttsr");
    expect(reset?.message).not.toContain("rules/a");
    expect(reset?.message).toContain("rules/c");
    projector.dispose();
  });

  test("projects R0 todo reminder snapshots without replacing canonical todo state", () => {
    const store = new OmpRuntimeStore({ threadId });
    const projector = new NotificationProjector({ source: store });
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

  test("projects snapshot.session changes and does not announce a revision-only refresh", () => {
    const store = new OmpRuntimeStore({ threadId });
    const projector = new NotificationProjector({ source: store });
    store.applySessionState({
      model: model("model-a", "Model A"),
      thinkingLevel: "low",
      sessionName: "Build session",
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
    expect(notices.every((notification) => notification.live === "off")).toBe(true);
    const before = projector.getBus().getSnapshot().revision;
    store.applySessionState({ contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } });
    expect(projector.getBus().getSnapshot().revision).toBe(before);
    expect(projector.getSnapshot().session.contextUsage?.percent).toBe(10);
    projector.dispose();
  });

  test("accepts every non-modal U4 handoff through a typed presentation seam", () => {
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
    projector.present(
      {
        kind: "open_url",
        url: "https://accounts.example/authorize?token=secret",
        launchUrl: "https://localhost/callback",
        instructions: "Return after signing in.",
      },
      { threadId, requestId: "oauth-1" as UiRequestId },
    );

    expect(projector.getSnapshot().statuses).toEqual([
      { statusKey: "build", statusText: "Running" },
    ]);
    expect(projector.getSnapshot().widgets[0]).toMatchObject({
      availability: "available",
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
    expect(projector.getSnapshot().oauth).toMatchObject({
      copyTarget: "https://localhost/callback",
      host: "localhost",
    });
    expect(projector.getBus().get(threadId, "extension:oauth:oauth-1")?.message).toBe(
      "Sign-in is ready to continue",
    );
    expect(projector.getBus().getSnapshot().notifications[1]?.message).not.toContain("secret");

    expect(() =>
      projector.present({ kind: "open_url", url: "javascript:alert(1)" }, { threadId }),
    ).toThrow(AppFailure);
    expect(projector.getSnapshot().error?.code).toBe("invalid_args");
    projector.dispose();
  });

  test("represents unsupported component widgets as unavailable instead of successful text", () => {
    const store = new OmpRuntimeStore({ threadId });
    const projector = new NotificationProjector({ source: store });
    projector.present({ kind: "setWidget", widgetKey: "component" }, { threadId });
    expect(projector.getSnapshot().widgets).toEqual([
      expect.objectContaining({
        widgetKey: "component",
        availability: "unavailable",
        lines: [],
      }),
    ]);
    projector.dispose();
  });
});
