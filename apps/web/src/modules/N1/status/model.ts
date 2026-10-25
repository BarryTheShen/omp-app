import type {
  GitDirtyFile,
  GithubReference,
  GitState,
  HostMetadata,
  ThreadId,
} from "@omp-app/contracts";
import { ThinkingLevel } from "@/modules/D1/contract";
import { thinkingLevelLabel, WIDEST_THINKING_WORDS } from "@/modules/D1/thinking/selector";
import type { SessionInfoState } from "@/modules/R0/store";
import type { StatusSegment } from "../contract";
import {
  accentIndex,
  folderName,
  formatClock,
  formatDuration,
  pullRequestHref,
  safeText,
} from "./format";

/** One port read, or why there is none. A segment with no reading leaves the bar. */
export type Reading<T> =
  | { readonly state: "ready"; readonly value: T }
  | { readonly state: "unavailable"; readonly reason: string };

/** The session fields N1 reads from R0: what omp last said about the model, the name and the goal. */
type SessionView = Pick<SessionInfoState, "model" | "thinkingLevel" | "sessionName" | "goal">;

export interface StatusInputs {
  /** Epoch milliseconds, for the local clock. */
  readonly now: number;
  /** The chat's session: omp's session id is the thread id (`ThreadId`, the session header `id`). */
  readonly threadId: ThreadId;
  readonly host: Reading<HostMetadata>;
  readonly git: Reading<GitState>;
  readonly pullRequest: Reading<GithubReference | null>;
  readonly session: SessionView;
  readonly subagents: Reading<number>;
  /** Active processing time so far, in milliseconds. */
  readonly activeMs: number;
}

/** The icons the bar draws, by name, so the model stays free of React. */
export type StatusIcon =
  | "host"
  | "folder"
  | "git"
  | "pull-request"
  | "session"
  | "model"
  | "goal"
  | "subagents"
  | "timer"
  | "clock";

export interface StatusChip {
  /** N1's typed status value: the visible text, the accessible label, or why there is none. */
  readonly segment: StatusSegment;
  /** Absent for the session name, which is drawn as a coloured dot instead. */
  readonly icon?: StatusIcon;
  /** The icon's colour cue; the words in the value say the same thing. */
  readonly tone: "neutral" | "clean" | "changed";
  /** The https address a link goes to (a pull request). */
  readonly href?: string;
  /** Which of the five chart colours marks a session name, from 1 to 5. */
  readonly accent?: number;
  /** What the tooltip says when the accessible label says less: the folder's full path, the server and the session ids. */
  readonly tooltip?: string;
  /** The widest text the value can show. The value keeps this width while its text changes, so the bar does not move. */
  readonly reserve?: string;
}

type SessionGoal = NonNullable<SessionView["goal"]>;
type GoalStatusName = SessionGoal["goal"]["status"];

/** The words omp shows for a goal status. A finished or dropped goal has none: omp's status line does not show it. */
const GOAL_STATUS_TEXT: Partial<Record<GoalStatusName, string>> = {
  active: "Goal active",
  paused: "Goal paused",
  "budget-limited": "Goal: budget reached",
};

const COMPACT_COUNT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** omp shows active time once it passes one second, so a first instant of work does not flash. */
const ACTIVE_TIME_THRESHOLD_MS = 1000;

const ACCENT_COUNT = 5;

/** The short form of omp's session id that the bar shows. */
const SESSION_ID_LENGTH = 8;

function available(
  id: string,
  label: string,
  accessibleLabel: string,
  value: string,
): StatusSegment {
  return { id, label, accessibleLabel, value: { state: "available", value } };
}

function unavailable(id: string, label: string, reason: string, icon?: StatusIcon): StatusChip {
  return {
    segment: {
      id,
      label,
      accessibleLabel: `${label}: not available`,
      value: { state: "unavailable", reason },
    },
    ...(icon === undefined ? {} : { icon }),
    tone: "neutral",
  };
}

function hostChip(reading: Reading<HostMetadata>): StatusChip {
  const id = "N2.hostname";
  const label = "Host name";
  if (reading.state === "unavailable") return unavailable(id, label, reading.reason, "host");
  const name = safeText(reading.value.hostname);
  if (name === "") return unavailable(id, label, "The host name is empty.", "host");
  return {
    segment: available(id, label, `Host name: ${name}`, name),
    icon: "host",
    tone: "neutral",
  };
}

function pathChip(reading: Reading<HostMetadata>, threadId: ThreadId): StatusChip {
  const id = "N2.path";
  const label = "Workspace folder";
  if (reading.state === "unavailable") return unavailable(id, label, reading.reason, "folder");
  const path = safeText(reading.value.displayPath);
  if (path === "") return unavailable(id, label, "The folder has no path.", "folder");
  // The bar draws the folder's name. The tooltip also carries the server and session ids, which the bar does not draw.
  const server = safeText(reading.value.hostname);
  const tooltip = [
    `${label}: ${path}`,
    ...(server === "" ? [] : [`Server ID: ${server}`]),
    `Session ID: ${threadId}`,
  ];
  return {
    segment: available(id, label, `Workspace folder: ${path}`, folderName(path)),
    icon: "folder",
    tone: "neutral",
    tooltip: tooltip.join("\n"),
  };
}

/**
 * Staged, unstaged and untracked counts from git's dirty files. An untracked file is counted only as
 * untracked, not also as an unstaged change.
 */
function countChanges(files: readonly GitDirtyFile[]): {
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
} {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const file of files) {
    if (file.status === "untracked") untracked += 1;
    else if (file.worktree) unstaged += 1;
    if (file.staged) staged += 1;
  }
  return { staged, unstaged, untracked };
}

function gitChip(reading: Reading<GitState>): StatusChip {
  const id = "N2.git";
  const label = "Git branch";
  if (reading.state === "unavailable") return unavailable(id, label, reading.reason, "git");
  const git = reading.value;
  if (git.repositoryRoot === null) {
    return unavailable(id, label, "This folder is not in a git repository.", "git");
  }
  const branch = git.branch ?? (git.head === null ? null : `detached at ${git.head.slice(0, 7)}`);
  if (branch === null) return unavailable(id, label, "This repository has no commits yet.", "git");

  const changes = countChanges(git.dirtyFiles);
  const parts: string[] = [];
  if (changes.unstaged > 0) parts.push(`${changes.unstaged} changed`);
  if (changes.staged > 0) parts.push(`${changes.staged} staged`);
  if (changes.untracked > 0) parts.push(`${changes.untracked} untracked`);
  const clean = parts.length === 0;
  return {
    segment: available(
      id,
      label,
      `${label}: ${branch}${clean ? ", clean" : `, ${parts.join(", ")}`}`,
      branch,
    ),
    icon: "git",
    tone: clean ? "clean" : "changed",
  };
}

function prChip(reading: Reading<GithubReference | null>): StatusChip {
  const id = "N2.pr";
  const label = "Pull request";
  if (reading.state === "unavailable")
    return unavailable(id, label, reading.reason, "pull-request");
  const pr = reading.value;
  if (pr === null)
    return unavailable(id, label, "This branch has no pull request.", "pull-request");
  const title = safeText(pr.title);
  const number = `#${pr.number}`;
  const state = pr.state === "unknown" ? "" : `, ${pr.state}`;
  const href = pullRequestHref(pr.url);
  return {
    segment: available(
      id,
      label,
      `${label} ${number}${title === "" ? "" : `: ${title}`}${state}`,
      number,
    ),
    icon: "pull-request",
    tone: "neutral",
    ...(href === undefined ? {} : { href }),
  };
}

function sessionChip(threadId: ThreadId): StatusChip {
  const id = "N2.session";
  const label = "Session";
  const short = threadId.slice(0, SESSION_ID_LENGTH);
  return {
    segment: available(id, label, `Session ID: ${short}`, short),
    icon: "session",
    tone: "neutral",
  };
}

function sessionNameChip(name: string | null): StatusChip {
  const id = "N2.session-name";
  const label = "Session name";
  const text = name === null ? "" : safeText(name);
  if (text === "") return unavailable(id, label, "This chat has no name yet.");
  return {
    segment: available(id, label, `${label}: ${text}`, text),
    tone: "neutral",
    accent: accentIndex(text, ACCENT_COUNT),
  };
}

/** The thinking level in words, or `null` when the model does not reason or the level is off. */
function thinkingText(reasoning: boolean | undefined, level: string | null): string | null {
  if (!reasoning) return null;
  const parsed = ThinkingLevel.safeParse(level);
  if (!parsed.success || parsed.data === "off") return null;
  return thinkingLevelLabel(parsed.data).toLowerCase();
}

function modelChip(model: SessionView["model"], level: SessionView["thinkingLevel"]): StatusChip {
  const id = "N2.model";
  const label = "Model";
  if (!model) return unavailable(id, label, "omp has not reported a model yet.", "model");
  const name = safeText(model.name === "" ? model.id : model.name);
  if (name === "") return unavailable(id, label, "omp reported a model with no name.", "model");
  const thinking = thinkingText(model.reasoning, level ?? null);
  const accessible = `${label}: ${name}${thinking === null ? "" : `, thinking ${thinking}`}`;
  return {
    segment: available(id, label, accessible, thinking === null ? name : `${name} · ${thinking}`),
    icon: "model",
    tone: "neutral",
    ...(model.reasoning ? { reserve: `${name} · ${WIDEST_THINKING_WORDS}` } : {}),
  };
}

/**
 * omp's status line shows a goal that is on or paused (modes/interactive-mode.ts:4814-4816, omp v18.12.6). A paused
 * goal has `enabled: false` (goals/runtime.ts:445-460), so it is shown by its status. A finished or dropped goal is
 * not shown.
 */
function goalChip(goal: SessionView["goal"]): StatusChip {
  const id = "N2.mode";
  const label = "Goal";
  if (!goal) return unavailable(id, label, "No goal is set for this chat.", "goal");
  const words = goal.mode === "exiting" ? "Goal finishing" : GOAL_STATUS_TEXT[goal.goal.status];
  if (words === undefined || !(goal.enabled || goal.goal.status === "paused")) {
    return unavailable(
      id,
      label,
      "This goal is not shown: omp shows a goal that is on or paused.",
      "goal",
    );
  }
  const { tokenBudget, tokensUsed } = goal.goal;
  const text =
    tokenBudget === undefined
      ? words
      : `${words} · ${COMPACT_COUNT.format(Math.max(0, tokenBudget - tokensUsed))} tokens left`;
  return { segment: available(id, label, text, text), icon: "goal", tone: "neutral" };
}

function subagentsChip(reading: Reading<number>): StatusChip {
  const id = "N2.subagents";
  const label = "Subagents";
  if (reading.state === "unavailable") return unavailable(id, label, reading.reason, "subagents");
  const running = reading.value;
  if (running === 0) return unavailable(id, label, "No subagents are running.", "subagents");
  const noun = running === 1 ? "subagent" : "subagents";
  return {
    segment: available(id, label, `${running} ${noun} running`, `${running} running`),
    icon: "subagents",
    tone: "neutral",
  };
}

function timeSpentChip(activeMs: number): StatusChip {
  const id = "N2.time-spent";
  const label = "Time spent";
  if (activeMs < ACTIVE_TIME_THRESHOLD_MS) {
    return unavailable(id, label, "No work has run in this chat yet.", "timer");
  }
  const duration = formatDuration(activeMs);
  return {
    segment: available(id, label, `Time spent working: about ${duration}`, duration),
    icon: "timer",
    tone: "neutral",
  };
}

function timeChip(now: number): StatusChip {
  const clock = formatClock(now);
  return {
    segment: available("N2.time", "Local time", `Local time ${clock}`, clock),
    icon: "clock",
    tone: "neutral",
  };
}

/**
 * The Pi mark: presentation only, not an omp state claim (the research note's N2.pi row). The roster carries no
 * focused agent, so the mark is always the one shown here.
 */
function piChip(): StatusChip {
  return { segment: available("N2.pi", "Pi", "Pi", "Pi"), tone: "neutral" };
}

/** Collaboration is shown only when I4 supplies its state; until then the row is unavailable, never a guessed zero. */
function collabChip(): StatusChip {
  return unavailable("N2.collab", "Collaboration", "Collaboration is not available yet.");
}

/**
 * The bar's chips in display order, every N2 row the bar shows once. A chip whose value is unavailable is
 * kept, so a caller can see why it is absent; the bar draws only the available ones.
 */
export function buildStatusChips(inputs: StatusInputs): readonly StatusChip[] {
  const { session } = inputs;
  return [
    piChip(),
    hostChip(inputs.host),
    pathChip(inputs.host, inputs.threadId),
    gitChip(inputs.git),
    prChip(inputs.pullRequest),
    sessionChip(inputs.threadId),
    sessionNameChip(session.sessionName),
    modelChip(session.model, session.thinkingLevel),
    goalChip(session.goal),
    subagentsChip(inputs.subagents),
    collabChip(),
    timeSpentChip(inputs.activeMs),
    timeChip(inputs.now),
  ];
}
