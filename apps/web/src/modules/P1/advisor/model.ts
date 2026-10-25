import type { ConfigEntry, ConfigSource, JsonValue, ProvenanceOrigin } from "@omp-app/contracts";
import type { AdvisorNote, AdvisorState } from "../contract";
import type { AdvisorCommandState, AdvisorConfigEntry, AdvisorConfigState } from "./advisor";

export type AdvisorDisplayStatus =
  | "idle"
  | "working"
  | "yielded"
  | "error"
  | "paused"
  | "quota"
  | "no-model"
  | "unknown";

export type AdvisorStatusTone = "neutral" | "success" | "warning" | "danger";

export interface AdvisorStatusViewModel {
  readonly label: string;
  readonly detail: string;
  readonly tone: AdvisorStatusTone;
  readonly modeLabel: string;
}

const STATUS_LABELS: Readonly<Record<AdvisorDisplayStatus, string>> = {
  idle: "Ready",
  working: "Reviewing",
  yielded: "Finished",
  error: "Needs attention",
  paused: "Paused",
  quota: "Waiting for provider",
  "no-model": "No model assigned",
  unknown: "Status unavailable",
};

const STATUS_DETAILS: Readonly<Record<AdvisorDisplayStatus, string>> = {
  idle: "The advisor is ready for the next turn.",
  working: "The advisor is reviewing the current turn.",
  yielded: "The advisor finished its latest review.",
  error: "The advisor reported an error.",
  paused: "The advisor is paused.",
  quota: "The advisor is waiting for its provider limit to clear.",
  "no-model": "Assign a model to the advisor role to start reviews.",
  unknown: "The running session has not reported advisor status.",
};

function displayStatus(
  status: AdvisorState["status"] | AdvisorDisplayStatus,
): AdvisorDisplayStatus {
  if (status === "idle" || status === "working" || status === "yielded" || status === "error")
    return status;
  if (status === "paused" || status === "quota" || status === "no-model") return status;
  return "unknown";
}

/** Converts typed advisor state into the short words used by the status chip. */
export function advisorStatusView(state: AdvisorState): AdvisorStatusViewModel {
  const status = displayStatus(state.status);
  const modeLabel = state.mode === "on" ? "On" : state.mode === "off" ? "Off" : "Unknown";
  return {
    label: STATUS_LABELS[status],
    detail: STATUS_DETAILS[status],
    tone:
      status === "error" || status === "no-model"
        ? "danger"
        : status === "working" || status === "quota"
          ? "warning"
          : status === "idle" || status === "yielded"
            ? "success"
            : "neutral",
    modeLabel,
  };
}

export interface AdvisorNoteViewModel {
  readonly text: string;
  readonly severityLabel: string;
  readonly ageLabel: string | null;
  readonly advisorLabel: string | null;
}

/** Keeps omp's delayed-note count visible; omp emits `turnsAgo` in
 * `packages/coding-agent/src/session/session-advisors.ts:1778-1787` and labels it `T-<n>` in
 * `packages/tui/src/chat/advisor-message.ts:121` at v18.9.1. */
export function advisorNoteView(note: AdvisorNote): AdvisorNoteViewModel {
  return {
    text: note.note,
    severityLabel:
      note.severity === "blocker" ? "Blocker" : note.severity === "concern" ? "Concern" : "Note",
    ageLabel:
      note.turnsAgo === undefined
        ? null
        : `${note.turnsAgo} ${note.turnsAgo === 1 ? "turn" : "turns"} ago`,
    advisorLabel: note.advisor && note.advisor !== "default" ? note.advisor : null,
  };
}

export interface AdvisorSettingDefinition {
  readonly key: AdvisorConfigEntry["key"];
  readonly label: string;
  readonly description: string;
  readonly kind: "boolean" | "select" | "number";
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly defaultValue: JsonValue;
}

/** Labels and defaults mirror omp's advisor settings declarations at v18.12.6:
 * `packages/coding-agent/src/advisor/settings.ts:10-163`; numeric domains are validated by
 * `packages/coding-agent/src/advisor/config.ts:49-70` (v18.9.1). `advisor.continueSeverity` (`:65-84`) is read when a
 * note arrives and when a final answer ends (`session/session-advisors.ts:1741,1806`), so a saved value reaches a running
 * chat; its `protocolDefault` pins only the default, never a saved value (`main.ts:261-269`). */
export const ADVISOR_SETTING_DEFINITIONS: readonly AdvisorSettingDefinition[] = [
  {
    key: "advisor.enabled",
    label: "Enable Advisor",
    description: "Pair a second model that reviews each turn and injects notes.",
    kind: "boolean",
    defaultValue: false,
  },
  {
    key: "advisor.syncBacklog",
    label: "Advisor Sync Backlog",
    description: "Pause the main agent until scheduled reviews catch up.",
    kind: "select",
    options: [
      { value: "off", label: "Off" },
      { value: "1", label: "One review" },
      { value: "3", label: "Three reviews" },
      { value: "5", label: "Five reviews" },
      { value: "strict", label: "All scheduled reviews" },
    ],
    defaultValue: "off",
  },
  {
    key: "advisor.immuneTurns",
    label: "Advisor Immune Turns",
    description:
      "Keep new concerns as non-interrupting notes for a number of turns after an interruption.",
    kind: "select",
    options: [0, 1, 2, 3, 4, 5].map((value) => ({
      value: String(value),
      label: `${value} ${value === 1 ? "turn" : "turns"}`,
    })),
    defaultValue: 3,
  },
  {
    key: "advisor.continueSeverity",
    label: "Advisor Continue Severity",
    description:
      "Minimum severity of an advisor note that wakes the agent after it finished with a final answer. Lower-severity notes stay as a card at the end of the transcript and reach the agent with your next message.",
    kind: "select",
    options: [
      { value: "nit", label: "Nit" },
      { value: "concern", label: "Concern" },
      { value: "blocker", label: "Blocker" },
    ],
    defaultValue: "concern",
  },
  {
    key: "advisor.reviewMode",
    label: "Advisor Review Mode",
    description: "Choose whether reviews happen every turn or only at the end of a run.",
    kind: "select",
    options: [
      { value: "turn", label: "Every turn" },
      { value: "agent-end", label: "At the end of a run" },
    ],
    defaultValue: "turn",
  },
  {
    key: "advisor.reviewInterval",
    label: "Advisor Review Interval",
    description: "Review every eligible update or every Nth eligible update.",
    kind: "number",
    defaultValue: 1,
  },
  {
    key: "advisor.maxNotesPerUpdate",
    label: "Advisor Max Notes Per Update",
    description: "Set the maximum number of non-blocking notes accepted for one update.",
    kind: "number",
    defaultValue: 4,
  },
  {
    key: "advisor.evictStaleResults",
    label: "Advisor Evict Stale Results",
    description:
      "Replace older read, search and file-list results with a short placeholder before each review.",
    kind: "boolean",
    defaultValue: true,
  },
];

export function advisorSettingValue(
  entry: ConfigEntry | undefined,
  definition: AdvisorSettingDefinition,
): JsonValue {
  return entry && !entry.secret ? entry.value : definition.defaultValue;
}

export interface AdvisorConfigRowViewModel {
  readonly definition: AdvisorSettingDefinition;
  readonly value: JsonValue;
  readonly sourceLabel: string;
  readonly provenanceLabel: string | null;
  readonly overridesLabel: string | null;
}

export interface AdvisorConfigViewModel {
  readonly phase: AdvisorConfigState["phase"];
  readonly layerLabel: string;
  readonly revision: string;
  readonly rows: readonly AdvisorConfigRowViewModel[];
  readonly error: string | null;
}

export function settingSourceLabel(source: ConfigSource): string {
  switch (source) {
    case "env":
      return "Environment";
    case "runtime":
      return "Current session";
    case "overlay":
      return "Additional config";
    case "project":
      return "Project settings";
    case "global":
      return "Global settings";
    case "default":
      return "Built-in default";
    case "app":
      return "This app";
  }
}

export function advisorConfigView(state: AdvisorConfigState): AdvisorConfigViewModel {
  const entries = new Map(state.entries.map((entry) => [entry.key, entry.value]));
  return {
    phase: state.phase,
    layerLabel: state.layer === "global" ? "Global settings" : "Project settings",
    revision: state.revision,
    rows: ADVISOR_SETTING_DEFINITIONS.map((definition) => {
      const entry = entries.get(definition.key);
      return {
        definition,
        value: advisorSettingValue(entry, definition),
        sourceLabel: entry ? settingSourceLabel(entry.source) : "Built-in default",
        provenanceLabel: entry?.provenance ? provenanceLabel(entry.provenance.origin) : null,
        overridesLabel: entry && entry.overrides.length > 0 ? "Lower settings also set this" : null,
      };
    }),
    error: state.error?.appError.message ?? null,
  };
}

function provenanceLabel(origin: ProvenanceOrigin): string {
  switch (origin) {
    case "omp-rpc":
      return "Reported by omp";
    case "omp-config":
      return "Read from omp settings";
    case "omp-session-file":
      return "Read from an omp session";
    case "host-fallback":
      return "Supplied by the app server";
    case "app-store":
      return "Saved by the app";
    case "fixture":
      return "Recorded example";
    case "client":
      return "Browser state";
  }
}

/** A stable text label for command progress; the command output itself remains opaque. */
export function advisorCommandLabel(state: AdvisorCommandState): string {
  switch (state.status) {
    case "idle":
      return "Ready";
    case "running":
      return "Working";
    case "completed":
      return "Finished";
    case "error":
      return "Could not complete";
  }
}

export function noteSeverityClass(severity: AdvisorNote["severity"]): string {
  return severity === "blocker"
    ? "border-destructive/40 bg-destructive/10"
    : severity === "concern"
      ? "border-warning/40 bg-warning/10"
      : "border-border bg-muted/30";
}
