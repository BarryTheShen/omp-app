import type { BackgroundJobStop } from "@omp-app/contracts";
import { createContext, useContext, useState } from "react";
import {
  BackgroundJobCommandContext,
  type StopOutcome,
  stopCommandFor,
  stopFailedOutcome,
  stopOutcomeOf,
} from "../U3/tool-card/background-job";
import { keptStopOutcome, resolveStopOutcome } from "../U3/tool-card/stopped-jobs";
import type { JobSnapshot } from "./models";

export interface BackgroundJobKeptStops {
  readonly stops: ReadonlyMap<string, BackgroundJobStop>;
  readonly launchedAt: ReadonlyMap<string, number>;
}

/** Stops the server kept, plus launch times for rejecting stops from earlier jobs with a reused id. */
export const BackgroundJobKeptStopsContext = createContext<BackgroundJobKeptStops | undefined>(
  undefined,
);

/** omp's command that stops every running background job (`/jobs kill all`, builtin-session.ts at v18.9.1). */
const STOP_ALL_COMMAND = "/jobs kill all";

/** omp's words when `/jobs kill all` stopped jobs: `Cancelled 2 background jobs.` or `Cancelled 1 background job.` */
const CANCELLED_ALL = /^Cancelled (\d+) background jobs?\.$/u;

/** omp's words when no job was running for `/jobs kill all` to stop. */
const NONE_TO_CANCEL = "No running background jobs to cancel.";

/** omp's reply as one line: its texts trimmed, empty ones dropped, and joined. */
function wordsOf(texts: readonly string[]): string {
  return texts
    .map((text) => text.replace(/\s+/gu, " ").trim())
    .filter((text) => text !== "")
    .join(" ");
}

/** How many jobs omp says `/jobs kill all` stopped, or undefined when its words give no count. */
export function stopAllCountOf(texts: readonly string[]): number | undefined {
  const cancelled = CANCELLED_ALL.exec(wordsOf(texts));
  return cancelled === null ? undefined : Number(cancelled[1]);
}

/**
 * omp's words for `/jobs kill all` (builtin-session.ts lines 93-104 at v18.9.1): `Cancelled N background jobs.`, or
 * `No running background jobs to cancel.` when none ran. Any other words are shown as omp wrote them.
 */
export function stopAllOutcomeOf(texts: readonly string[]): StopOutcome {
  const count = stopAllCountOf(texts);
  if (count !== undefined) {
    return {
      status: "stopped",
      sentence: `Stopped ${count} background job${count === 1 ? "" : "s"}.`,
    };
  }
  const words = wordsOf(texts);
  if (words === NONE_TO_CANCEL) {
    return {
      status: "finished",
      sentence: "Already finished: omp has no running background jobs to stop.",
    };
  }
  if (words === "")
    return { status: "unknown", sentence: "omp sent no reply to the stop request." };
  return { status: "unknown", sentence: `omp said: ${words}` };
}

/**
 * The Tasks view's stop controls. A chat with no command gateway offers none. Each stop is answered by omp's own
 * words: a job that a stop ended shows what omp said it is now, and loses its Stop control.
 */
export interface JobStops {
  /** A stop request is with omp. */
  readonly pending: boolean;
  /**
   * A failed or completed snapshot is authoritative; a running row may take a live outcome or a kept stop recorded after
   * that job's known launch.
   */
  statusOf(job: JobSnapshot): string;
  /** Whether a job shows its Stop control: it runs by the stops' answers, and no Stop all has ended every running job. */
  canStop(job: JobSnapshot): boolean;
  /** A live outcome, or a kept outcome that belongs to this running job. */
  outcomeOf(job: JobSnapshot): StopOutcome | undefined;
  /** omp's answer to Stop all, once asked. */
  readonly allOutcome: StopOutcome | undefined;
  /**
   * Whether the card's statuses are only as of the call that listed the jobs: a Stop all answered, but omp's count did
   * not say that every running job stopped.
   */
  readonly statusesAsOfCall: boolean;
  stop(jobId: string): Promise<void>;
  /**
   * Stops every job omp runs. `running` lists the card's jobs that run now. When omp's count of the jobs it stopped is
   * the number of `running`, those are the jobs it stopped, and no Stop control is left. Otherwise the card cannot tell
   * which ones it stopped: their status stays as the snapshot had it, and their Stop controls stay, so they can be stopped.
   */
  stopAll(running: readonly string[]): Promise<void>;
}

/** The stop controls for one list of background jobs, through the chat's command gateway. */
export function useJobStops(): JobStops {
  const runCommand = useContext(BackgroundJobCommandContext);
  const keptStops = useContext(BackgroundJobKeptStopsContext);
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, StopOutcome | undefined>>>({});
  const [allOutcome, setAllOutcome] = useState<StopOutcome | undefined>(undefined);
  const [cancelledByAll, setCancelledByAll] = useState<readonly string[]>([]);
  const [pending, setPending] = useState(false);
  // omp stopped every running job, or had none running: no Stop control is left. Otherwise the rows keep theirs.
  const [endedAll, setEndedAll] = useState(false);

  async function stop(jobId: string): Promise<void> {
    const command = stopCommandFor(jobId);
    if (runCommand === undefined || command === undefined) return;
    setPending(true);
    try {
      const outcome = stopOutcomeOf(await runCommand(command), jobId);
      setOutcomes((current) => ({ ...current, [jobId]: outcome }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOutcomes((current) => ({ ...current, [jobId]: stopFailedOutcome(jobId, message) }));
    } finally {
      setPending(false);
    }
  }

  async function stopAll(running: readonly string[]): Promise<void> {
    if (runCommand === undefined) return;
    setPending(true);
    try {
      const texts = await runCommand(STOP_ALL_COMMAND);
      const outcome = stopAllOutcomeOf(texts);
      const everyRunningJob = stopAllCountOf(texts) === running.length;
      setAllOutcome(outcome);
      setCancelledByAll(everyRunningJob ? running : []);
      setEndedAll(everyRunningJob || outcome.status === "finished");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAllOutcome({
        status: "failed",
        sentence: `Could not stop the background jobs: ${message}`,
      });
    } finally {
      setPending(false);
    }
  }

  function outcomeOf(job: JobSnapshot): StopOutcome | undefined {
    const stop = keptStops?.stops.get(job.id);
    return resolveStopOutcome(outcomes[job.id], job.status === "running", () =>
      keptStopOutcome(stop, keptStops?.launchedAt.get(job.id)),
    );
  }

  function statusOf(job: JobSnapshot): string {
    if (job.status !== "running") return job.status;
    const outcome = outcomeOf(job)?.status;
    if (outcome === "stopped") return "cancelled";
    if (outcome === "finished" || allOutcome?.status === "finished") return "already_completed";
    return cancelledByAll.includes(job.id) ? "cancelled" : job.status;
  }

  function canStop(job: JobSnapshot): boolean {
    return (
      runCommand !== undefined &&
      !endedAll &&
      statusOf(job) === "running" &&
      stopCommandFor(job.id) !== undefined
    );
  }

  return {
    pending,
    statusOf,
    canStop,
    outcomeOf,
    allOutcome,
    statusesAsOfCall: allOutcome !== undefined && !endedAll,
    stop,
    stopAll,
  };
}
