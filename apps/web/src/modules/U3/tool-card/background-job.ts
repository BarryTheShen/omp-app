import { createContext } from "react";
import type { BackgroundJobView } from "@/modules/R0/store/background-jobs";

/**
 * Runs one omp slash command through the chat's command gateway and resolves with omp's own words, one entry per text
 * omp printed. A chat with no gateway provides none, and its cards offer no Stop.
 */
export type BackgroundJobCommand = (command: string) => Promise<readonly string[]>;

/** The chat's command gateway, read by a background bash card's Stop control. */
export const BackgroundJobCommandContext = createContext<BackgroundJobCommand | undefined>(
  undefined,
);

/**
 * The chat's background jobs: each job's view, from its transcript and omp's process, by its call; and the stop each
 * card last got. The chat keeps a stop for its page, so a card shown again still knows what its stop said.
 */
export interface BackgroundJobsScope {
  viewOf(toolCallId: string): BackgroundJobView | undefined;
  outcomeOf(toolCallId: string): StopOutcome | undefined;
  recordOutcome(toolCallId: string, outcome: StopOutcome): void;
}

/** The chat's background jobs, read by a background bash card. Without them a card claims nothing about its job. */
export const BackgroundJobsContext = createContext<BackgroundJobsScope | undefined>(undefined);

/** omp's job ids are short words such as `bg_12` or `bash_a1b2c3`; anything else is never sent to omp. */
const JOB_ID = /^[A-Za-z0-9_-]{1,60}$/u;

/**
 * The `/jobs kill` command that stops one job, or undefined when the id is not a job id. A card stops only its own job:
 * `all` is refused here, so no card can ask omp to stop every job.
 */
export function stopCommandFor(jobId: string): string | undefined {
  if (jobId === "all" || !JOB_ID.test(jobId)) return undefined;
  return `/jobs kill ${jobId}`;
}

/**
 * Where a stop attempt ended. `stopped` and `finished` take the Stop control away: the job is no longer running.
 * `failed` and `unknown` leave it, so the person can try again.
 */
export type StopStatus = "stopped" | "finished" | "failed" | "unknown";

export interface StopOutcome {
  readonly status: StopStatus;
  /** One plain-English sentence for the card. */
  readonly sentence: string;
}

/** The outcome of a stop omp confirmed: the job was running, and omp stopped it. */
export function stoppedOutcome(_jobId: string): StopOutcome {
  return {
    status: "stopped",
    sentence: "The background command stopped before its result came back.",
  };
}

/** The outcome of a stop for a job omp no longer lists as running: it had already finished. */
export function finishedOutcome(jobId: string): StopOutcome {
  return {
    status: "finished",
    sentence: `Already finished: omp has no running job with id ${jobId}.`,
  };
}

/**
 * Reads omp's words for `/jobs kill <id>` into one outcome. omp (18.8.8 and later) answers in plain text. Its words
 * do not separate "not found" from "already finished", so an id omp no longer lists as running reads as finished. Words
 * the app does not recognise are shown as omp wrote them.
 */
export function stopOutcomeOf(texts: readonly string[], jobId: string): StopOutcome {
  const words = texts
    .map((text) => text.replace(/\s+/gu, " ").trim())
    .filter((text) => text !== "")
    .join(" ");
  if (words === `Cancelled background job ${jobId}.`) return stoppedOutcome(jobId);
  if (words === `No running background job with id "${jobId}".`) return finishedOutcome(jobId);
  if (words === `Could not cancel background job ${jobId}.`)
    return { status: "failed", sentence: `Could not stop background job ${jobId}.` };
  if (words === "Async background jobs are unavailable in this session.")
    return { status: "failed", sentence: "Background jobs are unavailable in this session." };
  if (words === "")
    return { status: "unknown", sentence: "omp sent no reply to the stop request." };
  return { status: "unknown", sentence: `omp said: ${words}` };
}

/** The outcome when the command did not reach omp, or omp did not answer. */
export function stopFailedOutcome(jobId: string, message: string): StopOutcome {
  return { status: "failed", sentence: `Could not stop background job ${jobId}: ${message}` };
}
