/**
 * Set up omp-app: the answers a person gave, turned into the changes the setup offers (a plan to approve). Pure: it
 * reads the values now in force and changes nothing; `apply.ts` makes the approved changes.
 */

/** Q1: what omp is mostly for; several may be picked. */
export type Use = "coding" | "writing" | "study" | "parallel" | "trying";
export type Approval = "always-ask" | "write" | "yolo";
export type Thinking = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ThemeModeAnswer = "system" | "light" | "dark";

/** What the person answered; a question skipped is absent and changes nothing. */
export interface Answers {
  readonly uses?: readonly Use[];
  /** Q2: where else the app is used. */
  readonly devices?: readonly ("computer" | "phone" | "tablet" | "other-computer")[];
  /** Q3: watch a chat work, or leave and come back. */
  readonly away?: boolean;
  /** Q4: notifications on this device. */
  readonly notify?: boolean;
  readonly themeMode?: ThemeModeAnswer;
  readonly style?: string;
  readonly groupTools?: boolean;
  /** Q7: hours a workspace may go unused before it closes; null never. */
  readonly closeAfter?: number | null;
  readonly approval?: Approval;
  readonly waitForReset?: boolean;
}

/** A setting kept in this browser, which the setup can change. */
export type BrowserSetting = "themeMode" | "style" | "groupTools" | "closeAfter";

export type SettingValue = string | number | boolean | null;

/** One change of the plan: a setting, its value now and after. */
export type Change =
  | {
      readonly where: "browser";
      readonly setting: BrowserSetting;
      readonly from: SettingValue;
      readonly to: SettingValue;
    }
  | {
      readonly where: "omp";
      /** One of `OMP_KEYS` from the questions, or any setting a chat proposed (`proposal.ts`). */
      readonly key: string;
      /** Why a chat proposed it. */
      readonly why?: string;
      readonly from: SettingValue;
      readonly to: SettingValue;
      /**
       * The person set the value now in force themselves (not omp's default): the plan shows the change unticked, so
       * the setup keeps what they chose unless they tick it.
       */
      readonly theirs: boolean;
    };

/** omp settings the setup may change (each checked to exist in `omp-settings.json`). */
export const OMP_KEYS = [
  "defaultThinkingLevel",
  "tools.approvalMode",
  "todo.eager",
  "task.autoParallel",
  "retry.waitForUsageReset",
] as const;
export type OmpKey = (typeof OMP_KEYS)[number];

/** A step the setup walks through that is not a setting: turning notifications on, signing in. */
export type Step = "notifications" | "sign-in" | "notifications-elsewhere";

/** The values in force now: this browser's, and omp's with whether the person set each. */
export interface Current {
  readonly browser: Readonly<Record<BrowserSetting, SettingValue>>;
  readonly omp: ReadonlyMap<OmpKey, { readonly value: SettingValue; readonly theirs: boolean }>;
  /** Notifications already on in this browser. */
  readonly notifying: boolean;
}

export interface Plan {
  readonly changes: readonly Change[];
  readonly steps: readonly Step[];
}

type OmpValues = Partial<Record<OmpKey, SettingValue>>;

/** Each use's omp settings. "Trying it out" keeps omp's defaults. */
export const PRESETS: Readonly<Record<Use, OmpValues>> = {
  coding: { defaultThinkingLevel: "high", "tools.approvalMode": "write", "todo.eager": "default" },
  writing: { defaultThinkingLevel: "medium", "tools.approvalMode": "write" },
  study: { defaultThinkingLevel: "medium", "tools.approvalMode": "always-ask" },
  parallel: {
    "task.autoParallel": "suggest",
    "retry.waitForUsageReset": true,
    "tools.approvalMode": "yolo",
  },
  trying: {},
};

/** Most careful first. */
const APPROVALS: readonly Approval[] = ["always-ask", "write", "yolo"];
/** Least thinking first. */
const THINKING: readonly Thinking[] = ["minimal", "low", "medium", "high", "xhigh"];

/**
 * Several uses together: the most careful approval and the most thinking any of them asks for; every other setting as
 * the first use that sets it.
 */
export function presetFor(uses: readonly Use[]): OmpValues {
  const merged: Record<string, SettingValue> = {};
  for (const use of uses) {
    for (const [key, value] of Object.entries(PRESETS[use])) {
      const now = merged[key];
      if (now === undefined) merged[key] = value as SettingValue;
      else if (key === "tools.approvalMode")
        merged[key] =
          APPROVALS[
            Math.min(APPROVALS.indexOf(now as Approval), APPROVALS.indexOf(value as Approval))
          ] ?? now;
      else if (key === "defaultThinkingLevel")
        merged[key] =
          THINKING[
            Math.max(THINKING.indexOf(now as Thinking), THINKING.indexOf(value as Thinking))
          ] ?? now;
    }
  }
  return merged as OmpValues;
}

/** The plan for these answers: only what would change, and the steps to walk through. */
export function planFor(answers: Answers, current: Current): Plan {
  const omp: OmpValues = { ...presetFor(answers.uses ?? []) };
  if (answers.approval !== undefined) omp["tools.approvalMode"] = answers.approval;
  if (answers.waitForReset !== undefined) omp["retry.waitForUsageReset"] = answers.waitForReset;

  const browser: Partial<Record<BrowserSetting, SettingValue>> = {};
  if (answers.themeMode !== undefined) browser.themeMode = answers.themeMode;
  if (answers.style !== undefined) browser.style = answers.style;
  if (answers.groupTools !== undefined) browser.groupTools = answers.groupTools;
  if (answers.closeAfter !== undefined) browser.closeAfter = answers.closeAfter;

  const changes: Change[] = [];
  for (const setting of ["themeMode", "style", "groupTools", "closeAfter"] as const) {
    const to = browser[setting];
    const from = current.browser[setting];
    if (to !== undefined && to !== from) changes.push({ where: "browser", setting, from, to });
  }
  for (const key of OMP_KEYS) {
    const to = omp[key];
    const now = current.omp.get(key);
    if (to === undefined || now?.value === to) continue;
    changes.push({ where: "omp", key, from: now?.value ?? null, to, theirs: now?.theirs ?? false });
  }

  const steps: Step[] = [];
  if (answers.notify === true && !current.notifying) steps.push("notifications");
  if (answers.devices?.some((device) => device !== "computer") === true)
    steps.push("notifications-elsewhere");
  steps.push("sign-in");
  return { changes, steps };
}
