import type { AppError, OmpWire, RpcSessionEvent, ThreadId, UiRequestId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { RuntimeSnapshot, TodoReminderState } from "../../R0/store";
import type { PresentationHandoff } from "../../U4/contract";
import { openUrlCopyTarget } from "../../U4/contract";
import type {
  AutoRetryEnd,
  AutoRetryStart,
  N1RuntimeEvent,
  Notification,
  RetryFallbackApplied,
  RetryFallbackSucceeded,
  SessionNotice,
  TodoReminder,
} from "../contract";
import {
  N1RuntimeEventSchema,
  Notification as NotificationSchema,
  TodoReminderSchema,
} from "../contract";
import { NotificationBus } from "./bus";

export type NotificationRuntimeEvent = N1RuntimeEvent | TodoReminder;

/** R0's normalized event seam. It carries the same typed envelope that `store.ingest` applies. */
export interface NormalizedRuntimeEventSource {
  readonly subscribe: (listener: (event: RpcSessionEvent, seq: number) => void) => () => void;
}

/** The normalized R0 snapshot fields consumed by N1. */
export type RuntimeSnapshotSource = Pick<
  {
    readonly getSnapshot: () => RuntimeSnapshot;
    readonly subscribe: (listener: (snapshot: RuntimeSnapshot) => void) => () => void;
  },
  "getSnapshot" | "subscribe"
>;

export interface TranscriptNoticeSink {
  /** Upsert by the notification's `(threadId, dedupeKey)` identity. */
  readonly upsert: (notification: Notification) => void;
}

export interface PresentationContext {
  readonly threadId: ThreadId;
  readonly requestId?: UiRequestId;
}

export interface StatusHandoffProjection {
  readonly statusKey: string;
  readonly statusText: string;
}

export interface WidgetHandoffProjection {
  readonly widgetKey: string;
  readonly placement: "aboveEditor" | "belowEditor";
  readonly lines: readonly string[];
  readonly availability: "available" | "unavailable";
  readonly reason?: string;
}

/** The full URL is retained only as the explicit action target; it is never put in notice text. */
export interface OAuthHandoffProjection {
  readonly copyTarget: string;
  readonly host: string;
  readonly instructions?: string;
}

export interface NotificationProjectionSnapshot {
  readonly threadId: ThreadId;
  readonly revision: number;
  readonly session: RuntimeSnapshot["session"];
  readonly statuses: readonly StatusHandoffProjection[];
  readonly widgets: readonly WidgetHandoffProjection[];
  readonly title: string | null;
  readonly oauth: OAuthHandoffProjection | null;
  readonly error: AppError | null;
}

export interface NotificationProjectorOptions {
  readonly source: RuntimeSnapshotSource;
  readonly bus?: NotificationBus;
  readonly events?: NormalizedRuntimeEventSource;
  readonly transcript?: TranscriptNoticeSink;
  readonly onEditorText?: (text: string, context: PresentationContext) => void;
  readonly now?: () => number;
}

export interface ProjectionEventContext {
  readonly threadId: ThreadId;
  readonly sequence?: number;
  readonly todoReminderIdentity?: string;
}

export const MAX_WIDGET_LINES = 10;
const MAX_DISPLAY_TEXT = 360;
const EMPTY_PROJECTION_STATUSES: readonly StatusHandoffProjection[] = Object.freeze([]);
const EMPTY_PROJECTION_WIDGETS: readonly WidgetHandoffProjection[] = Object.freeze([]);
const NOTIFICATION_EVENT_SCHEMA = N1RuntimeEventSchema.or(TodoReminderSchema);

function invalidProjection(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

function unavailableProjection(message: string): AppFailure {
  return new AppFailure({ code: "unavailable", message, retryable: false });
}

function internalProjection(message: string, cause: unknown): AppFailure {
  return new AppFailure({ code: "internal", message, retryable: true }, { cause });
}

function cleanText(value: string, maxLength = MAX_DISPLAY_TEXT): string {
  const withoutControls = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
      codePoint === 127
      ? " "
      : character;
  }).join("");
  const redacted = withoutControls
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\b(?:api[-_ ]?key|token|password|secret)\s*[:=]\s*\S+/gi, "<redacted>")
    .replace(/(?:\/home\/[^\s]+|\/Users\/[^\s]+|\/root\/[^\s]+|\/tmp\/[^\s]+)/g, "<path>")
    .trim();
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function cleanOptionalText(value: unknown, maxLength = MAX_DISPLAY_TEXT): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? cleanText(value, maxLength)
    : undefined;
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function modelLabel(model: OmpWire.ModelInfo | null | undefined): string | undefined {
  if (!model) return undefined;
  return cleanText(model.name || model.id || model.provider);
}

function modelIdentity(model: OmpWire.ModelInfo | null | undefined): string | null {
  return model ? `${model.provider}/${model.id}` : null;
}

function freezeStatus(status: StatusHandoffProjection): StatusHandoffProjection {
  return Object.freeze({ ...status });
}

function freezeWidget(widget: WidgetHandoffProjection): WidgetHandoffProjection {
  return Object.freeze({ ...widget, lines: Object.freeze([...widget.lines]) });
}

function projectionSnapshot(
  previous: NotificationProjectionSnapshot | undefined,
  next: {
    readonly threadId: ThreadId;
    readonly session: RuntimeSnapshot["session"];
    readonly statuses?: readonly StatusHandoffProjection[];
    readonly widgets?: readonly WidgetHandoffProjection[];
    readonly title?: string | null;
    readonly oauth?: OAuthHandoffProjection | null;
    readonly error?: AppError | null;
  },
): NotificationProjectionSnapshot {
  const statuses = next.statuses ?? previous?.statuses ?? EMPTY_PROJECTION_STATUSES;
  const widgets = next.widgets ?? previous?.widgets ?? EMPTY_PROJECTION_WIDGETS;
  return Object.freeze({
    threadId: next.threadId,
    revision: (previous?.revision ?? 0) + 1,
    session: next.session,
    statuses: Object.freeze([...statuses]),
    widgets: Object.freeze([...widgets]),
    title: next.title === undefined ? (previous?.title ?? null) : next.title,
    oauth: next.oauth === undefined ? (previous?.oauth ?? null) : next.oauth,
    error: next.error === undefined ? (previous?.error ?? null) : next.error,
  });
}

function notification(
  threadId: ThreadId,
  values: Omit<Notification, "threadId" | "focus">,
): Notification {
  return NotificationSchema.parse({ ...values, threadId, focus: "preserve" });
}

function severityForNotify(
  type: "info" | "warning" | "error" | undefined,
): Notification["severity"] {
  if (type === "warning") return "warning";
  if (type === "error") return "error";
  return "info";
}

function liveForSeverity(severity: Notification["severity"]): Notification["live"] {
  if (severity === "error") return "assertive";
  if (severity === "warning" || severity === "info") return "polite";
  return "off";
}

function retryDelay(delayMs: number): string {
  const seconds = delayMs / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function retryStartNotification(
  threadId: ThreadId,
  event: AutoRetryStart,
  now: () => number,
): Notification {
  const error = cleanOptionalText(event.errorMessage);
  const detail = error ? `: ${error}` : "";
  return notification(threadId, {
    dedupeKey: "retry:active",
    severity: "warning",
    placement: "transcript",
    message: `Retrying (${event.attempt}/${event.maxAttempts}) in ${retryDelay(event.delayMs)}${detail}`,
    source: "omp.retry",
    expiresAt: now() + event.delayMs,
    live: "polite",
  });
}

function retryEndNotification(threadId: ThreadId, event: AutoRetryEnd): Notification {
  if (event.success) {
    return notification(threadId, {
      dedupeKey: "retry:result",
      severity: "success",
      placement: "transcript",
      message: `Recovered after retry (${event.attempt})`,
      source: "omp.retry",
      live: "off",
    });
  }
  const error = cleanOptionalText(event.finalError);
  return notification(threadId, {
    dedupeKey: "retry:result",
    severity: "error",
    placement: "transcript",
    message: error
      ? `Retry failed after ${event.attempt} attempt${event.attempt === 1 ? "" : "s"}: ${error}`
      : `Retry failed after ${event.attempt} attempt${event.attempt === 1 ? "" : "s"}`,
    source: "omp.retry",
    live: "assertive",
  });
}

function fallbackNotification(
  threadId: ThreadId,
  event: RetryFallbackApplied | RetryFallbackSucceeded,
): Notification {
  if (event.type === "retry_fallback_applied") {
    const reason = cleanOptionalText(event.reason);
    return notification(threadId, {
      dedupeKey: `fallback:${hashText(event.role)}`,
      severity: "warning",
      placement: "toast",
      message: `Fallback: ${cleanText(event.from)} → ${cleanText(event.to)}${reason ? ` — ${reason}` : ""}`,
      source: "omp.fallback",
      live: "polite",
    });
  }
  return notification(threadId, {
    dedupeKey: `fallback:${hashText(event.role)}`,
    severity: "success",
    placement: "toast",
    message: `Fallback succeeded on ${cleanText(event.model)}`,
    source: "omp.fallback",
    live: "off",
  });
}

function ruleText(rule: Record<string, unknown>, index: number): string {
  const name = cleanOptionalText(rule.name) ?? cleanOptionalText(rule.id) ?? `Rule ${index + 1}`;
  const description = cleanOptionalText(rule.description, 180);
  const content = cleanOptionalText(rule.content, 180);
  return [name, description, content]
    .filter((value): value is string => value !== undefined)
    .join(" — ");
}

function ttsrNotification(
  threadId: ThreadId,
  rules: readonly Record<string, unknown>[],
): Notification {
  const lines = rules.map(ruleText).filter((line) => line.length > 0);
  return notification(threadId, {
    dedupeKey: "ttsr",
    severity: "warning",
    placement: "banner",
    message:
      lines.length === 0
        ? "Injecting rule(s)"
        : `Injecting rule(s):\n${lines.map((line) => `• ${line}`).join("\n")}`,
    source: "omp.ttsr",
    live: "polite",
  });
}

function todoReminderNotification(
  threadId: ThreadId,
  event: TodoReminder,
  identity?: string,
): Notification {
  const lines = event.todos.slice(0, 50).map((todo) => {
    const task = cleanText(todo.content || "Unnamed task", 180);
    return `• ${task}`;
  });
  const suffix = event.todos.length > 50 ? `\n• … ${event.todos.length - 50} more` : "";
  return notification(threadId, {
    dedupeKey: `todo-reminder:${event.attempt}${identity === undefined ? "" : `:${hashText(identity)}`}`,
    severity: "warning",
    placement: "transcript",
    message: `Todo reminder (${event.attempt}/${event.maxAttempts})${lines.length > 0 ? `\n${lines.join("\n")}${suffix}` : ""}`,
    source: "omp.todo",
    live: "polite",
  });
}

function sessionNotice(threadId: ThreadId, dedupeKey: string, message: string): Notification {
  return notification(threadId, {
    dedupeKey,
    severity: "info",
    placement: "inline",
    message,
    source: "session",
    live: "off",
  });
}

function sessionChanges(
  threadId: ThreadId,
  previous: RuntimeSnapshot["session"],
  next: RuntimeSnapshot["session"],
): readonly Notification[] {
  const notices: Notification[] = [];
  const previousModel = modelIdentity(previous.model);
  const nextModel = modelIdentity(next.model);
  if (previousModel !== nextModel && next.model) {
    const label = modelLabel(next.model);
    if (label) notices.push(sessionNotice(threadId, "session:model", `Model changed to ${label}`));
  }
  if (previous.thinkingLevel !== next.thinkingLevel && next.thinkingLevel) {
    notices.push(
      sessionNotice(
        threadId,
        "session:thinking",
        `Thinking level changed to ${cleanText(next.thinkingLevel)}`,
      ),
    );
  }
  if (previous.sessionName !== next.sessionName && next.sessionName) {
    notices.push(
      sessionNotice(threadId, "session:name", `Session renamed to ${cleanText(next.sessionName)}`),
    );
  }
  return notices;
}

function reminderContentIdentity(
  attempt: number,
  maxAttempts: number,
  todos: readonly unknown[],
): string {
  return `${attempt}:${maxAttempts}:${JSON.stringify(todos)}`;
}

function identityForReminder(reminder: TodoReminderState): string {
  return `${reminderContentIdentity(reminder.attempt, reminder.maxAttempts, reminder.todos)}:${reminder.afterMessage ?? "root"}`;
}

function toReminderEvent(reminder: TodoReminderState): TodoReminder {
  return {
    type: "todo_reminder",
    todos: reminder.todos.map((todo) => ({
      content: todo.content,
      status: todo.status,
      ...(todo.blocker === undefined ? {} : { blocker: todo.blocker }),
      ...(todo.details === undefined ? {} : { details: todo.details }),
      ...(todo.notes === undefined ? {} : { notes: [...todo.notes] }),
    })),
    attempt: reminder.attempt,
    maxAttempts: reminder.maxAttempts,
  };
}

function safeHttpUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidProjection("The authorization destination is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidProjection("Only http(s) authorization destinations can be opened.");
  }
  if (parsed.username || parsed.password) {
    throw invalidProjection("Authorization destinations cannot contain embedded credentials.");
  }
  return parsed;
}

function handoffNotification(
  handoff: PresentationHandoff,
  context: PresentationContext,
): Notification | undefined {
  switch (handoff.kind) {
    case "notify": {
      const severity = severityForNotify(handoff.notifyType);
      return notification(context.threadId, {
        dedupeKey: `extension:notify:${hashText(`${handoff.notifyType ?? "info"}:${handoff.message}`)}`,
        severity,
        placement: "toast",
        message: cleanText(handoff.message),
        source: "extension",
        live: liveForSeverity(severity),
      });
    }
    case "open_url":
      safeHttpUrl(handoff.url);
      safeHttpUrl(openUrlCopyTarget(handoff));
      return notification(context.threadId, {
        dedupeKey: context.requestId ? `extension:oauth:${context.requestId}` : "extension:oauth",
        severity: "info",
        placement: "toast",
        message: "Sign-in is ready to continue",
        source: "extension.oauth",
        live: "polite",
      });
    case "setStatus":
    case "setWidget":
    case "setTitle":
    case "set_editor_text":
      return undefined;
  }
}
function freezeProjectionError(error: AppFailure): AppError {
  return Object.freeze({ ...error.appError });
}

/**
 * Projects R0's normalized event stream and session snapshot into N1's bus and handoff state. It
 * keeps only browser presentation state; transcript, todo, and session truth remain owned by R0/U1/U5.
 */
export class NotificationProjector {
  private readonly source: RuntimeSnapshotSource;
  private readonly bus: NotificationBus;
  private readonly transcript: TranscriptNoticeSink | undefined;
  private readonly onEditorText: NotificationProjectorOptions["onEditorText"];
  private readonly now: () => number;
  private readonly listeners = new Set<(snapshot: NotificationProjectionSnapshot) => void>();
  private readonly seenReminders = new Set<string>();
  private readonly seenReminderEvents = new Set<string>();
  private readonly stopSource: () => void;
  private readonly stopEvents: (() => void) | undefined;
  private runtimeSnapshot: RuntimeSnapshot;
  private snapshot: NotificationProjectionSnapshot;
  private lastEventSequence = 0;
  private ttsrRules: Record<string, unknown>[] = [];
  private statuses = new Map<string, StatusHandoffProjection>();
  private widgets = new Map<string, WidgetHandoffProjection>();
  private title: string | null = null;
  private oauth: OAuthHandoffProjection | null = null;

  public constructor(options: NotificationProjectorOptions) {
    this.source = options.source;
    this.bus = options.bus ?? new NotificationBus();
    this.transcript = options.transcript;
    this.onEditorText = options.onEditorText;
    this.now = options.now ?? (() => Date.now());
    this.runtimeSnapshot = options.source.getSnapshot();
    for (const reminder of this.runtimeSnapshot.todoReminders) {
      this.seenReminders.add(identityForReminder(reminder));
    }
    this.snapshot = projectionSnapshot(undefined, {
      threadId: this.runtimeSnapshot.threadId,
      session: this.runtimeSnapshot.session,
      statuses: EMPTY_PROJECTION_STATUSES,
      widgets: EMPTY_PROJECTION_WIDGETS,
      title: null,
      oauth: null,
      error: null,
    });
    this.stopSource = this.source.subscribe(this.onRuntimeSnapshot);
    this.stopEvents = options.events?.subscribe((event, seq) => {
      if (event.kind !== "omp") return;
      this.ingest(event.event as NotificationRuntimeEvent, {
        threadId: this.source.getSnapshot().threadId,
        sequence: seq,
      });
    });
  }

  public getBus(): NotificationBus {
    return this.bus;
  }

  public getSnapshot(): NotificationProjectionSnapshot {
    return this.snapshot;
  }

  public subscribe(listener: (snapshot: NotificationProjectionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public dispose(): void {
    this.stopSource();
    this.stopEvents?.();
    this.listeners.clear();
  }

  /** Apply one typed event already normalized by R0. */
  public ingest(
    event: NotificationRuntimeEvent,
    context: ProjectionEventContext,
  ): readonly Notification[] {
    if (context.sequence !== undefined) {
      if (!Number.isSafeInteger(context.sequence) || context.sequence < 1) {
        const failure = invalidProjection("The normalized event sequence is invalid.");
        this.recordFailure(failure, context.threadId);
        return [];
      }
      if (context.sequence <= this.lastEventSequence) return [];
      this.lastEventSequence = context.sequence;
    }

    const parsed = NOTIFICATION_EVENT_SCHEMA.safeParse(event);
    if (!parsed.success) {
      const failure = invalidProjection("The normalized notification event is malformed.");
      this.recordFailure(failure, context.threadId);
      return [];
    }
    const normalized = parsed.data as NotificationRuntimeEvent;
    const notifications: Notification[] = [];
    if (normalized.type !== "ttsr_triggered") this.ttsrRules = [];

    switch (normalized.type) {
      case "auto_retry_start":
        notifications.push(retryStartNotification(context.threadId, normalized, this.now));
        break;
      case "auto_retry_end":
        this.bus.dismiss(context.threadId, "retry:active");
        notifications.push(retryEndNotification(context.threadId, normalized));
        break;
      case "retry_fallback_applied":
      case "retry_fallback_succeeded":
        notifications.push(fallbackNotification(context.threadId, normalized));
        break;
      case "ttsr_triggered": {
        const incoming = normalized.rules.map((rule) => ({ ...rule }));
        const fingerprints = new Set(this.ttsrRules.map((rule) => JSON.stringify(rule)));
        for (const rule of incoming) {
          const fingerprint = JSON.stringify(rule);
          if (!fingerprints.has(fingerprint)) {
            this.ttsrRules.push(rule);
            fingerprints.add(fingerprint);
          }
        }
        notifications.push(ttsrNotification(context.threadId, this.ttsrRules));
        break;
      }
      case "todo_reminder": {
        this.seenReminderEvents.add(
          reminderContentIdentity(normalized.attempt, normalized.maxAttempts, normalized.todos),
        );
        const identity =
          context.todoReminderIdentity ??
          (context.sequence === undefined ? undefined : `event:${context.sequence}`);
        notifications.push(todoReminderNotification(context.threadId, normalized, identity));
        break;
      }
      case "notice":
        notifications.push(this.noticeEventNotification(context.threadId, normalized));
        break;
      case "todo_auto_clear":
        break;
    }

    const published: Notification[] = [];
    for (const next of notifications) {
      const result = this.bus.publish(next);
      if (result !== "deduplicated") {
        published.push(next);
        if (next.placement === "transcript") this.writeTranscript(next);
      }
    }
    this.commit({ error: null });
    return published;
  }

  /** Implements U4's non-modal presentation sink without answering or correlating requests. */
  public present(handoff: PresentationHandoff, context: PresentationContext): void {
    try {
      switch (handoff.kind) {
        case "setStatus":
          if (handoff.statusText === undefined) this.statuses.delete(handoff.statusKey);
          else {
            this.statuses.set(
              handoff.statusKey,
              freezeStatus({
                statusKey: handoff.statusKey,
                statusText: cleanText(handoff.statusText),
              }),
            );
          }
          this.commit({ error: null });
          return;
        case "setWidget":
          this.applyWidget(handoff.widgetKey, handoff.widgetLines, handoff.widgetPlacement);
          this.commit({ error: null });
          return;
        case "setTitle": {
          const title = cleanText(handoff.title);
          if (!title) throw invalidProjection("The extension title is empty.");
          this.title = title;
          this.commit({ error: null });
          return;
        }
        case "set_editor_text":
          if (!this.onEditorText) {
            throw unavailableProjection(
              "Editor text handoffs are unavailable in this presentation host.",
            );
          }
          this.onEditorText(handoff.text, context);
          this.commit({ error: null });
          return;
        case "notify":
        case "open_url": {
          const next = handoffNotification(handoff, context);
          if (handoff.kind === "open_url") {
            const target = safeHttpUrl(openUrlCopyTarget(handoff));
            this.oauth = Object.freeze({
              copyTarget: target.toString(),
              host: target.host,
              ...(handoff.instructions === undefined
                ? {}
                : { instructions: cleanText(handoff.instructions) }),
            });
          }
          if (next) {
            const result = this.bus.publish(next);
            if (result !== "deduplicated" && next.placement === "transcript") {
              this.writeTranscript(next);
            }
          }
          this.commit({ error: null });
          return;
        }
      }
    } catch (error) {
      const failure =
        error instanceof AppFailure
          ? error
          : internalProjection("The presentation handoff could not be applied.", error);
      this.recordFailure(failure, context.threadId);
      throw failure;
    }
  }

  private readonly onRuntimeSnapshot = (next: RuntimeSnapshot): void => {
    const previous = this.runtimeSnapshot;
    this.runtimeSnapshot = next;
    if (next.threadId !== previous.threadId) {
      this.seenReminders.clear();
      this.seenReminderEvents.clear();
      for (const reminder of next.todoReminders)
        this.seenReminders.add(identityForReminder(reminder));
      this.ttsrRules = [];
      this.commit({
        threadId: next.threadId,
        session: next.session,
        statuses: [],
        widgets: [],
        title: null,
        oauth: null,
        error: null,
      });
      return;
    }

    for (const notice of sessionChanges(next.threadId, previous.session, next.session)) {
      const result = this.bus.publish(notice);
      if (result !== "deduplicated" && notice.placement === "transcript")
        this.writeTranscript(notice);
    }
    for (const reminder of next.todoReminders) {
      const identity = identityForReminder(reminder);
      if (this.seenReminders.has(identity)) continue;
      const contentIdentity = reminderContentIdentity(
        reminder.attempt,
        reminder.maxAttempts,
        reminder.todos,
      );
      if (this.seenReminderEvents.delete(contentIdentity)) {
        this.seenReminders.add(identity);
        continue;
      }
      this.seenReminders.add(identity);
      this.ingest(toReminderEvent(reminder), {
        threadId: next.threadId,
        todoReminderIdentity: identity,
      });
    }
    this.commit({ session: next.session, error: null });
  };

  private readonly noticeEventNotification = (
    threadId: ThreadId,
    event: SessionNotice,
  ): Notification => {
    const severity = event.level;
    return notification(threadId, {
      dedupeKey: `session:notice:${hashText(`${event.source ?? "omp"}:${event.message}`)}`,
      severity,
      placement: severity === "error" ? "banner" : "toast",
      message: cleanText(event.message),
      ...(cleanOptionalText(event.source) === undefined
        ? {}
        : { source: cleanText(event.source as string, 120) }),
      live: severity === "error" ? "assertive" : "polite",
    });
  };

  private readonly applyWidget = (
    widgetKey: string,
    lines: readonly string[] | undefined,
    placement: "aboveEditor" | "belowEditor" | undefined,
  ): void => {
    if (lines === undefined) {
      this.widgets.set(
        widgetKey,
        freezeWidget({
          widgetKey,
          placement: placement ?? "belowEditor",
          lines: [],
          availability: "unavailable",
          reason: "This extension widget has no portable text representation.",
        }),
      );
      return;
    }
    const cleaned = lines.slice(0, MAX_WIDGET_LINES).map((line) => cleanText(line, 180));
    if (lines.length > MAX_WIDGET_LINES) {
      cleaned[MAX_WIDGET_LINES - 1] = `… ${lines.length - MAX_WIDGET_LINES + 1} more`;
    }
    this.widgets.set(
      widgetKey,
      freezeWidget({
        widgetKey,
        placement: placement ?? "belowEditor",
        lines: cleaned,
        availability: "available",
      }),
    );
  };

  private readonly writeTranscript = (next: Notification): void => {
    if (!this.transcript) return;
    try {
      this.transcript.upsert(next);
    } catch (error) {
      this.recordFailure(
        internalProjection("The transcript notice could not be inserted.", error),
        next.threadId,
      );
    }
  };

  private readonly recordFailure = (failure: AppFailure, threadId: ThreadId): void => {
    this.commit({ threadId, error: freezeProjectionError(failure) });
    const next = notification(threadId, {
      dedupeKey: "projection:error",
      severity: "error",
      placement: "banner",
      message: cleanText(failure.appError.message),
      source: "N1",
      live: "assertive",
    });
    this.bus.publish(next);
  };

  private readonly commit = (changes: {
    readonly threadId?: ThreadId;
    readonly session?: RuntimeSnapshot["session"];
    readonly statuses?: readonly StatusHandoffProjection[];
    readonly widgets?: readonly WidgetHandoffProjection[];
    readonly title?: string | null;
    readonly oauth?: OAuthHandoffProjection | null;
    readonly error?: AppError | null;
  }): void => {
    const statuses = changes.statuses
      ? [...changes.statuses].sort((left, right) => left.statusKey.localeCompare(right.statusKey))
      : [...this.statuses.values()].sort((left, right) =>
          left.statusKey.localeCompare(right.statusKey),
        );
    const widgets = changes.widgets
      ? [...changes.widgets].sort((left, right) => left.widgetKey.localeCompare(right.widgetKey))
      : [...this.widgets.values()].sort((left, right) =>
          left.widgetKey.localeCompare(right.widgetKey),
        );
    this.statuses = new Map(statuses.map((status) => [status.statusKey, status]));
    this.widgets = new Map(widgets.map((widget) => [widget.widgetKey, widget]));
    this.snapshot = projectionSnapshot(this.snapshot, {
      threadId: changes.threadId ?? this.runtimeSnapshot.threadId,
      session: changes.session ?? this.runtimeSnapshot.session,
      statuses,
      widgets,
      title: changes.title === undefined ? this.title : changes.title,
      oauth: changes.oauth === undefined ? this.oauth : changes.oauth,
      ...(changes.error === undefined ? {} : { error: changes.error }),
    });
    for (const listener of this.listeners) listener(this.snapshot);
  };
}
