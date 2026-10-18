import {
  checkScrubbed,
  FolderPath,
  type GitState,
  type ScrubProblem,
  ThreadId,
} from "@omp-app/contracts";
import type { PresentationHandoff } from "../../U4/contract";
import {
  AutoRetryEndSchema,
  AutoRetryStartSchema,
  Notification,
  RetryFallbackAppliedSchema,
  RetryFallbackSucceededSchema,
  SessionNoticeSchema,
  TodoAutoClearSchema,
  TodoReminderSchema,
  TtsrTriggeredSchema,
} from "../contract";
import type { StatusInputs } from "../status/model";

/** Synthetic values model the typed R0/U4 snapshots N1 consumes; they are not captured user data. */
export const N1_FIXTURE_THREAD_ID = ThreadId.parse("01903e7a-0000-7000-8000-000000000002");

export const N1_RUNTIME_EVENT_FIXTURES = [
  AutoRetryStartSchema.parse({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 250,
    errorMessage: "Temporary provider failure",
    errorId: 7,
  }),
  AutoRetryEndSchema.parse({
    type: "auto_retry_end",
    success: true,
    attempt: 2,
  }),
  AutoRetryEndSchema.parse({
    type: "auto_retry_end",
    success: false,
    attempt: 3,
    finalError: "The provider did not recover",
    retryErrors: [{ code: "provider_unavailable", attempt: 1 }],
  }),
  RetryFallbackAppliedSchema.parse({
    type: "retry_fallback_applied",
    from: "primary-model",
    to: "backup-model",
    role: "main",
    reason: "The primary provider was unavailable",
  }),
  RetryFallbackSucceededSchema.parse({
    type: "retry_fallback_succeeded",
    model: "backup-model",
    role: "main",
  }),
  TtsrTriggeredSchema.parse({
    type: "ttsr_triggered",
    rules: [
      {
        name: "review-notes",
        description: "Keep review notes concise",
        content: "Use short sections",
      },
      {
        name: "review-notes-2",
        description: "Mention tests",
        content: "Name the check",
      },
      {
        name: "long-rule",
        description: "A long rule is elided in the feedback surface",
        content: "Long rule content ".repeat(80),
      },
    ],
  }),
  TodoAutoClearSchema.parse({
    type: "todo_auto_clear",
  }),
  SessionNoticeSchema.parse({
    type: "notice",
    level: "info",
    message: "The session is ready",
    source: "session",
  }),
  SessionNoticeSchema.parse({
    type: "notice",
    level: "warning",
    message: "The provider is taking longer than usual",
    source: "provider",
  }),
  SessionNoticeSchema.parse({
    type: "notice",
    level: "error",
    message: "The provider rejected the request",
    source: "provider",
  }),
] as const;

export const N1_TODO_REMINDER_FIXTURE = TodoReminderSchema.parse({
  type: "todo_reminder",
  attempt: 2,
  maxAttempts: 4,
  todos: [
    { content: "Review the change", status: "pending" },
    { content: "Run the checks", status: "blocked", blocker: "The provider is offline" },
  ],
});

export const N1_PRESENTATION_HANDOFF_FIXTURES: readonly PresentationHandoff[] = [
  { kind: "notify", message: "The extension finished", notifyType: "info" },
  { kind: "setStatus", statusKey: "build", statusText: "Ready" },
  {
    kind: "setWidget",
    widgetKey: "build",
    widgetLines: ["Build ready"],
    widgetPlacement: "belowEditor",
  },
  { kind: "setTitle", title: "Ready" },
  { kind: "set_editor_text", text: "Draft text" },
  {
    kind: "open_url",
    url: "https://auth.example.invalid/authorize",
    launchUrl: "https://127.0.0.1:43120/launch",
    instructions: "Open the short launch link in your browser",
  },
];

export const N1_NOTIFICATION_FIXTURES = [
  Notification.parse({
    threadId: N1_FIXTURE_THREAD_ID,
    dedupeKey: "retry:1:provider",
    severity: "warning",
    placement: "toast",
    message: "Retrying request (attempt 1 of 3)",
    source: "omp.retry",
    live: "polite",
    focus: "preserve",
  }),
  Notification.parse({
    threadId: N1_FIXTURE_THREAD_ID,
    dedupeKey: "retry:result",
    severity: "error",
    placement: "banner",
    message: "The provider did not recover",
    source: "omp.retry",
    live: "assertive",
    focus: "preserve",
  }),
  Notification.parse({
    threadId: N1_FIXTURE_THREAD_ID,
    dedupeKey: "session:notice:1:ready",
    severity: "info",
    placement: "quiet",
    message: "The session is ready",
    source: "session",
    live: "off",
    focus: "preserve",
  }),
  Notification.parse({
    threadId: N1_FIXTURE_THREAD_ID,
    dedupeKey: "todo-reminder:2",
    severity: "warning",
    placement: "transcript",
    message: "Two tasks still need attention",
    source: "omp.todo",
    live: "polite",
    focus: "preserve",
  }),
] as const;

function gitState(overrides: Partial<GitState> = {}): GitState {
  return {
    repositoryRoot: FolderPath.parse("/work/demo"),
    branch: "main",
    head: "abcdef1234567890",
    detached: false,
    dirtyFiles: [],
    ahead: 0,
    behind: 0,
    worktrees: [],
    observedAt: "2026-10-18T12:00:00.000Z",
    ...overrides,
  };
}

const NO_SESSION: StatusInputs["session"] = {
  model: null,
  thinkingLevel: null,
  sessionName: null,
  goal: null,
};

export const N1_STATUS_INPUTS: StatusInputs = {
  now: Date.UTC(2026, 9, 18, 12, 0, 0),
  threadId: N1_FIXTURE_THREAD_ID,
  host: { state: "ready", value: { hostname: "fixture-host", displayPath: "~/code/demo" } },
  git: { state: "ready", value: gitState() },
  pullRequest: { state: "ready", value: null },
  session: NO_SESSION,
  subagents: { state: "ready", value: 0 },
  activeMs: 0,
};

export const N1_DIRTY_STATUS_INPUTS: StatusInputs = {
  ...N1_STATUS_INPUTS,
  git: {
    state: "ready",
    value: gitState({
      dirtyFiles: [
        { path: "src/changed.ts", status: "modified", staged: false, worktree: true },
        { path: "src/staged.ts", status: "modified", staged: true, worktree: false },
        { path: "notes/new.md", status: "untracked", staged: false, worktree: true },
      ],
    }),
  },
  activeMs: 12_500,
};

export const N1_NO_REPOSITORY_STATUS_INPUTS: StatusInputs = {
  ...N1_STATUS_INPUTS,
  host: { state: "unavailable", reason: "The host policy withholds local metadata." },
  git: {
    state: "ready",
    value: gitState({ repositoryRoot: null, branch: null, head: null }),
  },
  pullRequest: { state: "unavailable", reason: "Pull-request metadata is not available." },
  subagents: { state: "unavailable", reason: "Subagent events are not available." },
};
export const N1_UNBORN_REPOSITORY_STATUS_INPUTS: StatusInputs = {
  ...N1_STATUS_INPUTS,
  git: {
    state: "ready",
    value: gitState({ branch: null, head: null }),
  },
};

export const N1_LONG_PATH_STATUS_INPUTS: StatusInputs = {
  ...N1_STATUS_INPUTS,
  host: {
    state: "ready",
    value: {
      hostname: "fixture-host",
      displayPath: "~/code/projects/a-very-long-folder-name/active-workspace",
    },
  },
};

/** All values sent to acceptance tests, kept in one object for a single scrub assertion. */
export const N1_SCRUBBED_FIXTURES = {
  runtimeEvents: N1_RUNTIME_EVENT_FIXTURES,
  todoReminder: N1_TODO_REMINDER_FIXTURE,
  handoffs: N1_PRESENTATION_HANDOFF_FIXTURES,
  notifications: N1_NOTIFICATION_FIXTURES,
  statuses: [
    N1_STATUS_INPUTS,
    N1_DIRTY_STATUS_INPUTS,
    N1_NO_REPOSITORY_STATUS_INPUTS,
    N1_UNBORN_REPOSITORY_STATUS_INPUTS,
    N1_LONG_PATH_STATUS_INPUTS,
  ],
} as const;

export function assertN1FixturesAreScrubbed(): readonly ScrubProblem[] {
  return checkScrubbed(JSON.stringify(N1_SCRUBBED_FIXTURES));
}
