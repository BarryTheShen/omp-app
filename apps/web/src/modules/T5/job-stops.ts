import { useContext, useState } from "react";
import {
  BackgroundJobCommandContext,
  type StopOutcome,
  stopCommandFor,
  stopFailedOutcome,
  stopOutcomeOf,
} from "../U3/tool-card/background-job";
import type { JobSnapshot } from "./models";

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
   * The status a job shows, in its row and in the card's header. The card's snapshot is what the job was when its wait
   * ran; a stop that omp answered says what the job is now.
   */
  statusOf(job: JobSnapshot): string;
  /** Whether a job shows its Stop control: it runs by the stops' answers, and no Stop all has ended the rest. */
  canStop(job: JobSnapshot): boolean;
  /** omp's answer to the Stop of one job, once asked. */
  outcomeOf(jobId: string): StopOutcome | undefined;
  /** omp's answer to Stop all, once asked. */
  readonly allOutcome: StopOutcome | undefined;
  stop(jobId: string): Promise<void>;
  /**
   * Stops every job omp runs. `running` lists the card's jobs that run now. When omp's count of the jobs it stopped is
   * the number of `running`, those are the jobs it stopped. Otherwise the card cannot tell which ones, so their status
   * stays as the snapshot had it.
   */
  stopAll(running: readonly string[]): Promise<void>;
}

/** The stop controls for one list of background jobs, through the chat's command gateway. */
export function useJobStops(): JobStops {
  const runCommand = useContext(BackgroundJobCommandContext);
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, StopOutcome | undefined>>>({});
  const [allOutcome, setAllOutcome] = useState<StopOutcome | undefined>(undefined);
  const [cancelledByAll, setCancelledByAll] = useState<readonly string[]>([]);
  const [pending, setPending] = useState(false);
  // omp stopped every job it runs, or had none running: no Stop control is left.
  const allEnded = allOutcome?.status === "stopped" || allOutcome?.status === "finished";

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
      setAllOutcome(stopAllOutcomeOf(texts));
      setCancelledByAll(stopAllCountOf(texts) === running.length ? running : []);
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

  function statusOf(job: JobSnapshot): string {
    if (job.status !== "running") return job.status;
    const own = outcomes[job.id]?.status;
    if (own === "stopped") return "cancelled";
    if (own === "finished" || allOutcome?.status === "finished") return "already_completed";
    return cancelledByAll.includes(job.id) ? "cancelled" : job.status;
  }

  function canStop(job: JobSnapshot): boolean {
    return (
      runCommand !== undefined &&
      !allEnded &&
      statusOf(job) === "running" &&
      stopCommandFor(job.id) !== undefined
    );
  }

  return {
    pending,
    statusOf,
    canStop,
    outcomeOf(jobId) {
      return outcomes[jobId];
    },
    allOutcome,
    stop,
    stopAll,
  };
}
