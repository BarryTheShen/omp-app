import type { AppError, OmpEvent, OmpWire, ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { RuntimeSnapshot, TodoReminderState } from "../../R0/store";
import type { PresentationHandoff } from "../../U4/contract";
import type {
  AutoRetryEnd,
  AutoRetryStart,
  Notification,
  RetryFallbackApplied,
  RetryFallbackSucceeded,
  SessionNotice,
} from "../contract";
import {
  N1RuntimeEventSchema,
  Notification as NotificationSchema,
  TodoReminderSchema,
} from "../contract";
import { NotificationBus } from "./bus";
import type { RetiredNotices } from "./retired";

export interface NormalizedRuntimeEventSource {
  readonly subscribeOmpEvents: (
    types: readonly string[] | undefined,
    listener: (event: OmpEvent, seq: number, replayed: boolean) => void,
  ) => () => void;
}

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
  readonly sequence?: number;
  /** Replayed from the chat's history (a reopen or a reconnect): shown, but not read aloud again. */
  readonly replayed?: boolean;
}

export interface StatusHandoffProjection {
  readonly statusKey: string;
  readonly statusText: string;
}

export interface WidgetHandoffProjection {
  readonly widgetKey: string;
  readonly placement: "aboveEditor" | "belowEditor";
  readonly lines: readonly string[];
}

export interface NotificationProjectionSnapshot {
  readonly threadId: ThreadId;
  readonly revision: number;
  readonly session: RuntimeSnapshot["session"];
  readonly statuses: readonly StatusHandoffProjection[];
  readonly widgets: readonly WidgetHandoffProjection[];
  readonly title: string | null;
  readonly error: AppError | null;
}

export interface NotificationProjectorOptions {
  readonly source: RuntimeSnapshotSource;
  readonly bus?: NotificationBus;
  /** Used when no `bus` is given: the stream notices a person let go of, which a replay must not bring back. */
  readonly retired?: RetiredNotices;
  readonly events?: NormalizedRuntimeEventSource;
  readonly transcript?: TranscriptNoticeSink;
  readonly onEditorText?: (text: string, context: PresentationContext) => void;
  readonly now?: () => number;
}

export interface ProjectionEventContext {
  readonly threadId: ThreadId;
  readonly sequence?: number;
  /** Replayed from the chat's history: shown, but not read aloud again. */
  readonly replayed?: boolean;
}

export const MAX_WIDGET_LINES = 10;
/** The dedupe key of the projection's own error. The feedback strip shows it once, as an inline alert. */
export const PROJECTION_ERROR_KEY = "projection:error";
const MAX_DISPLAY_TEXT = 360;
const EMPTY_PROJECTION_STATUSES: readonly StatusHandoffProjection[] = Object.freeze([]);
const EMPTY_PROJECTION_WIDGETS: readonly WidgetHandoffProjection[] = Object.freeze([]);
const KNOWN_N1_EVENT_TYPES: Readonly<Record<string, true>> = {
  auto_retry_start: true,
  auto_retry_end: true,
  retry_fallback_applied: true,
  retry_fallback_succeeded: true,
  ttsr_triggered: true,
  todo_auto_clear: true,
  notice: true,
};

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

function sameStatuses(
  left: readonly StatusHandoffProjection[],
  right: readonly StatusHandoffProjection[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a === undefined ||
      b === undefined ||
      a.statusKey !== b.statusKey ||
      a.statusText !== b.statusText
    )
      return false;
  }
  return true;
}

function sameWidgets(
  left: readonly WidgetHandoffProjection[],
  right: readonly WidgetHandoffProjection[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a === undefined ||
      b === undefined ||
      a.widgetKey !== b.widgetKey ||
      a.placement !== b.placement ||
      a.lines.length !== b.lines.length
    ) {
      return false;
    }
    for (let line = 0; line < a.lines.length; line += 1) {
      if (a.lines[line] !== b.lines[line]) return false;
    }
  }
  return true;
}

function projectionSnapshot(
  previous: NotificationProjectionSnapshot | undefined,
  next: {
    readonly threadId: ThreadId;
    readonly session: RuntimeSnapshot["session"];
    readonly statuses?: readonly StatusHandoffProjection[];
    readonly widgets?: readonly WidgetHandoffProjection[];
    readonly title?: string | null;
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
    placement: "banner",
    message: `Retrying (${event.attempt}/${event.maxAttempts}) in ${retryDelay(event.delayMs)}${detail}`,
    source: "omp.retry",
    expiresAt: now() + event.delayMs,
    live: "polite",
  });
}

function retryEndNotification(threadId: ThreadId, event: AutoRetryEnd): Notification | undefined {
  if (event.success) return undefined;
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
  reminder: TodoReminderState,
  identity: string,
): Notification {
  const lines = reminder.todos.slice(0, 50).map((todo) => {
    const task = cleanText(todo.content || "Unnamed task", 180);
    return `• ${task}`;
  });
  const suffix = reminder.todos.length > 50 ? `\n• … ${reminder.todos.length - 50} more` : "";
  return notification(threadId, {
    dedupeKey: `todo-reminder:${reminder.attempt}:${hashText(identity)}`,
    severity: "warning",
    placement: "transcript",
    message: `Todo reminder (${reminder.attempt}/${reminder.maxAttempts})${lines.length > 0 ? `\n${lines.join("\n")}${suffix}` : ""}`,
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
  if (
    previous.sessionName !== null &&
    previous.sessionName !== next.sessionName &&
    next.sessionName
  ) {
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

function handoffNotification(
  handoff: Exclude<PresentationHandoff, { readonly kind: "open_url" }>,
  context: PresentationContext,
): Notification | undefined {
  switch (handoff.kind) {
    case "notify": {
      const severity = severityForNotify(handoff.notifyType);
      const fingerprint = hashText(`${handoff.notifyType ?? "info"}:${handoff.message}`);
      const dedupeKey =
        context.sequence === undefined
          ? `extension:notify:${fingerprint}`
          : `extension:notify:${context.sequence}:${fingerprint}`;
      return notification(context.threadId, {
        dedupeKey,
        severity,
        placement: "toast",
        message: cleanText(handoff.message),
        source: "extension",
        live: context.replayed === true ? "off" : liveForSeverity(severity),
      });
    }
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
  private readonly stopSource: () => void;
  private readonly stopEvents: (() => void) | undefined;
  private runtimeSnapshot: RuntimeSnapshot;
  private snapshot: NotificationProjectionSnapshot;
  private lastEventSequence = 0;
  private ttsrRules: Record<string, unknown>[] = [];
  private statuses = new Map<string, StatusHandoffProjection>();
  private widgets = new Map<string, WidgetHandoffProjection>();
  private title: string | null = null;

  public constructor(options: NotificationProjectorOptions) {
    this.source = options.source;
    this.bus = options.bus ?? new NotificationBus({ retired: options.retired });
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
      error: null,
    });
    this.stopSource = this.source.subscribe(this.onRuntimeSnapshot);
    this.stopEvents = options.events?.subscribeOmpEvents(undefined, (event, seq, replayed) => {
      this.ingest(event, { threadId: this.runtimeSnapshot.threadId, sequence: seq, replayed });
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
    this.bus.clearForThread(this.snapshot.threadId);
    this.listeners.clear();
  }

  /** Apply one raw Omp event; unrelated Omp event kinds are silently ignored. */
  public ingest(event: unknown, context: ProjectionEventContext): readonly Notification[] {
    const eventType =
      typeof event === "object" &&
      event !== null &&
      !Array.isArray(event) &&
      "type" in event &&
      typeof event.type === "string"
        ? event.type
        : undefined;
    const knownEvent = eventType !== undefined && Object.hasOwn(KNOWN_N1_EVENT_TYPES, eventType);
    if (context.sequence !== undefined) {
      if (!Number.isSafeInteger(context.sequence) || context.sequence < 1) {
        if (knownEvent) {
          this.recordFailure(
            invalidProjection("omp sent an update this app could not read."),
            context.threadId,
          );
        }
        return [];
      }
      if (context.sequence <= this.lastEventSequence) return [];
      this.lastEventSequence = context.sequence;
    }

    if (eventType !== "ttsr_triggered") this.ttsrRules = [];
    if (!knownEvent) return [];

    const parsed = N1RuntimeEventSchema.safeParse(event);
    if (!parsed.success) {
      this.ttsrRules = [];
      this.recordFailure(
        invalidProjection("omp sent an update this app could not read."),
        context.threadId,
      );
      return [];
    }
    this.clearFailure(context.threadId);

    const normalized = parsed.data;
    const notifications: Notification[] = [];
    switch (normalized.type) {
      case "auto_retry_start":
        notifications.push(retryStartNotification(context.threadId, normalized, this.now));
        break;
      case "auto_retry_end": {
        this.bus.dismiss(context.threadId, "retry:active");
        const retryResult = retryEndNotification(context.threadId, normalized);
        if (retryResult) notifications.push(retryResult);
        break;
      }
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
      case "notice":
        if (normalized.level !== "error") {
          notifications.push(
            this.noticeEventNotification(context.threadId, normalized, context.sequence),
          );
        }
        break;
      case "todo_auto_clear":
        break;
    }

    const published: Notification[] = [];
    // A replayed event was read when it first arrived: it is shown, but not announced again.
    const replayed = context.replayed === true;
    for (const candidate of notifications) {
      const next: Notification = replayed ? { ...candidate, live: "off" } : candidate;
      if (this.publishNotification(next)) published.push(next);
    }
    return published;
  }

  /** Implements U4's non-modal presentation sink without answering or correlating requests. */
  public present(
    handoff: Exclude<PresentationHandoff, { readonly kind: "open_url" }>,
    context: PresentationContext,
  ): void {
    const projectionContext = { ...context, threadId: this.snapshot.threadId };
    try {
      switch (handoff.kind) {
        case "setStatus": {
          const statusText =
            handoff.statusText === undefined ? undefined : cleanText(handoff.statusText);
          const current = this.statuses.get(handoff.statusKey);
          const changed =
            statusText === undefined ? current !== undefined : current?.statusText !== statusText;
          this.clearFailure(projectionContext.threadId);
          if (changed) {
            if (statusText === undefined) this.statuses.delete(handoff.statusKey);
            else {
              this.statuses.set(
                handoff.statusKey,
                freezeStatus({ statusKey: handoff.statusKey, statusText }),
              );
            }
            this.commit({ statuses: [...this.statuses.values()] });
          }
          return;
        }
        case "setWidget":
          this.clearFailure(projectionContext.threadId);
          if (this.applyWidget(handoff.widgetKey, handoff.widgetLines, handoff.widgetPlacement)) {
            this.commit({ widgets: [...this.widgets.values()] });
          }
          return;
        case "setTitle": {
          const title = cleanText(handoff.title);
          if (!title) throw invalidProjection("The extension title is empty.");
          this.clearFailure(projectionContext.threadId);
          if (title !== this.title) {
            this.title = title;
            this.commit({ title });
          }
          return;
        }
        case "set_editor_text":
          if (!this.onEditorText) {
            throw unavailableProjection("This editor update is unavailable right now.");
          }
          this.onEditorText(handoff.text, projectionContext);
          this.clearFailure(projectionContext.threadId);
          return;
        case "notify": {
          const next = handoffNotification(handoff, projectionContext);
          this.clearFailure(projectionContext.threadId);
          if (next) this.publishNotification(next);
          return;
        }
      }
    } catch (error) {
      const failure =
        error instanceof AppFailure
          ? error
          : internalProjection("An omp update could not be shown.", error);
      this.recordFailure(failure, projectionContext.threadId);
    }
  }

  private readonly onRuntimeSnapshot = (next: RuntimeSnapshot): void => {
    const previous = this.runtimeSnapshot;
    const sessionWasLoaded =
      previous.session.model !== null ||
      previous.session.thinkingLevel !== null ||
      previous.session.sessionName !== null;
    this.runtimeSnapshot = next;

    if (previous.needsRefetch && !next.needsRefetch) {
      this.bus.dismiss(next.threadId, "retry:active");
      this.ttsrRules = [];
    }

    if (next.session !== previous.session && this.snapshot.session !== next.session) {
      this.commit({ session: next.session });
    }

    if (sessionWasLoaded) {
      const changes = sessionChanges(next.threadId, previous.session, next.session);
      if (changes.length > 0) this.clearFailure(next.threadId);
      for (const notice of changes) this.publishNotification(notice);
    }
    if (next.todoReminders !== previous.todoReminders) {
      const currentIdentities = new Set<string>();
      for (const reminder of next.todoReminders) {
        const parsed = TodoReminderSchema.safeParse({
          type: "todo_reminder",
          todos: reminder.todos,
          attempt: reminder.attempt,
          maxAttempts: reminder.maxAttempts,
        });
        if (!parsed.success) {
          this.recordFailure(
            invalidProjection("omp sent a todo reminder this app could not read."),
            next.threadId,
          );
          continue;
        }
        const validReminder: TodoReminderState = {
          ...parsed.data,
          afterMessage: reminder.afterMessage,
        };
        const identity = identityForReminder(validReminder);
        currentIdentities.add(identity);
        if (this.seenReminders.has(identity)) continue;
        this.seenReminders.add(identity);
        this.clearFailure(next.threadId);
        this.publishNotification(todoReminderNotification(next.threadId, validReminder, identity));
      }
      for (const identity of this.seenReminders) {
        if (!currentIdentities.has(identity)) this.seenReminders.delete(identity);
      }
    }
  };

  private readonly noticeEventNotification = (
    threadId: ThreadId,
    event: SessionNotice,
    sequence?: number,
  ): Notification => {
    const severity = event.level;
    const source = cleanOptionalText(event.source, 120);
    const fingerprint = hashText(`${source ?? "omp"}:${event.message}`);
    const dedupeKey =
      sequence === undefined
        ? `session:notice:${fingerprint}`
        : `session:notice:${sequence}:${fingerprint}`;
    return notification(threadId, {
      dedupeKey,
      severity,
      placement: severity === "error" ? "banner" : "toast",
      message: cleanText(event.message),
      ...(source === undefined ? {} : { source }),
      live: severity === "error" ? "assertive" : "polite",
    });
  };

  private readonly applyWidget = (
    widgetKey: string,
    lines: readonly string[] | undefined,
    placement: "aboveEditor" | "belowEditor" | undefined,
  ): boolean => {
    if (lines === undefined) return this.widgets.delete(widgetKey);
    const cleaned = lines.slice(0, MAX_WIDGET_LINES).map((line) => cleanText(line, 180));
    if (lines.length > MAX_WIDGET_LINES) {
      cleaned[MAX_WIDGET_LINES - 1] = `… ${lines.length - MAX_WIDGET_LINES + 1} more`;
    }
    const next = freezeWidget({
      widgetKey,
      placement: placement ?? "aboveEditor",
      lines: cleaned,
    });

    const previous = this.widgets.get(widgetKey);
    if (
      previous &&
      previous.placement === next.placement &&
      previous.lines.length === next.lines.length &&
      previous.lines.every((line, index) => line === next.lines[index])
    ) {
      return false;
    }
    this.widgets.set(widgetKey, next);
    return true;
  };

  private readonly publishNotification = (next: Notification): boolean => {
    if (this.bus.publish(next) === "deduplicated") return false;
    if (next.placement === "transcript") this.writeTranscript(next);
    return true;
  };

  private readonly writeTranscript = (next: Notification): void => {
    if (!this.transcript) return;
    try {
      this.transcript.upsert(next);
    } catch (error) {
      this.recordFailure(
        internalProjection("This update could not be added to the conversation.", error),
        next.threadId,
      );
    }
  };

  private readonly clearFailure = (threadId: ThreadId): void => {
    if (threadId !== this.snapshot.threadId) return;
    this.bus.dismiss(threadId, PROJECTION_ERROR_KEY);
    if (this.snapshot.error !== null) this.commit({ error: null });
  };

  private readonly recordFailure = (failure: AppFailure, threadId: ThreadId): void => {
    this.commit({ error: freezeProjectionError(failure) });
    this.bus.publish(
      notification(threadId, {
        dedupeKey: PROJECTION_ERROR_KEY,
        severity: "error",
        placement: "banner",
        message: cleanText(failure.appError.message),
        source: "N1",
        live: "assertive",
      }),
    );
  };

  private readonly commit = (changes: {
    readonly session?: RuntimeSnapshot["session"];
    readonly statuses?: readonly StatusHandoffProjection[];
    readonly widgets?: readonly WidgetHandoffProjection[];
    readonly title?: string | null;
    readonly error?: AppError | null;
  }): void => {
    const statuses =
      changes.statuses === undefined
        ? this.snapshot.statuses
        : [...changes.statuses].sort((left, right) =>
            left.statusKey.localeCompare(right.statusKey),
          );
    const widgets =
      changes.widgets === undefined
        ? this.snapshot.widgets
        : [...changes.widgets].sort((left, right) => left.widgetKey.localeCompare(right.widgetKey));
    const session = changes.session ?? this.runtimeSnapshot.session;
    const title = changes.title === undefined ? this.title : changes.title;
    const error = changes.error === undefined ? this.snapshot.error : changes.error;
    if (
      this.snapshot.session === session &&
      sameStatuses(this.snapshot.statuses, statuses) &&
      sameWidgets(this.snapshot.widgets, widgets) &&
      this.snapshot.title === title &&
      this.snapshot.error === error
    ) {
      return;
    }
    if (changes.statuses !== undefined) {
      this.statuses = new Map(statuses.map((status) => [status.statusKey, status]));
    }
    if (changes.widgets !== undefined) {
      this.widgets = new Map(widgets.map((widget) => [widget.widgetKey, widget]));
    }
    this.snapshot = projectionSnapshot(this.snapshot, {
      threadId: this.snapshot.threadId,
      session,
      statuses,
      widgets,
      title,
      error,
    });
    for (const listener of this.listeners) listener(this.snapshot);
  };
}
