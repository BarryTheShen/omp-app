import type { MessageKey } from "@omp-app/contracts";
import { z } from "zod";
import type { ProcessState, RuntimeMessage } from "./store";

/**
 * What the chat's transcript and omp's process say about one background bash job.
 * - `running`: the job's launch belongs to the omp process that runs now, and no result has come back.
 * - `finished`: omp delivered the job's result into the chat. omp does not mark a failed job, so it is finished too.
 * - `ended`: the job's launch belongs to an omp process that is gone (or none runs), and no result came back.
 * - `unknown`: a process runs, but the chat does not yet know when it started, so the card claims nothing.
 */
export type BackgroundJobView =
  | { readonly kind: "running"; readonly jobId: string }
  | { readonly kind: "finished"; readonly jobId: string }
  | { readonly kind: "failed"; readonly jobId: string }
  | { readonly kind: "cancelled"; readonly jobId: string }
  | { readonly kind: "ended"; readonly jobId: string }
  | { readonly kind: "unknown"; readonly jobId: string };

/** A bash call omp moved to the background: its call, its job, and when its tool result was written (ms). */
interface Launch {
  readonly toolCallId: string;
  readonly jobId: string;
  readonly at: number;
}

/** omp's `details.async` on a command it moved to the background (the launch result). */
const AsyncLaunch = z.looseObject({
  async: z.looseObject({ jobId: z.string(), state: z.string() }),
});
/** omp v18.9.1 `packages/coding-agent/src/session/async-job-delivery.ts` includes each delivered job's status. */
const DeliveredJobs = z.looseObject({
  jobs: z.array(z.looseObject({ jobId: z.string(), status: z.string().optional() })),
});

/** The process states in which an omp process may still run a background job. */
const LIVE: Partial<Record<ProcessState["status"], true>> = {
  starting: true,
  ready: true,
  running: true,
};

/**
 * The view of every background bash job in the chat, keyed by its call id. A delivered result belongs to the nearest
 * earlier launch with the same job id: omp numbers its jobs per process, so a later process reuses ids, and a result
 * delivered after a relaunch belongs to the relaunch. A job that no result follows is `running` only when its launch is
 * in the process that runs now (launched at or after that process started); any other launch is `ended`.
 */
export function backgroundJobViews(
  order: readonly MessageKey[],
  messages: Readonly<Record<MessageKey, RuntimeMessage>>,
  process: ProcessState,
): ReadonlyMap<string, BackgroundJobView> {
  const launches: Launch[] = [];
  const awaiting = new Map<string, Launch>();
  const delivered = new Map<string, string | undefined>();
  for (const key of order) {
    const message = messages[key]?.message;
    if (message?.role === "toolResult") {
      const launch = launchOf(
        message.toolCallId,
        message.toolName,
        message.details,
        message.timestamp,
      );
      if (launch === undefined) continue;
      launches.push(launch);
      awaiting.set(launch.jobId, launch);
    } else if (message?.role === "custom" && message.customType === "async-result") {
      for (const job of deliveredJobsOf(message.details)) {
        const launch = awaiting.get(job.jobId);
        if (launch === undefined) continue;
        delivered.set(launch.toolCallId, job.status ?? "completed");
        awaiting.delete(job.jobId);
      }
    }
  }
  const views = new Map<string, BackgroundJobView>();
  for (const launch of launches) {
    views.set(launch.toolCallId, viewOf(launch, delivered.get(launch.toolCallId), process));
  }
  return views;
}

/**
 * When each background bash call's launch result was written (ms), keyed by its call id. A kept stop of a job applies to
 * a card only when the stop was recorded after the card's launch: omp numbers jobs per process, so a later job can carry
 * the id of a stopped one.
 */
export function backgroundJobLaunchTimes(
  order: readonly MessageKey[],
  messages: Readonly<Record<MessageKey, RuntimeMessage>>,
): ReadonlyMap<string, number> {
  const times = new Map<string, number>();
  for (const key of order) {
    const message = messages[key]?.message;
    if (message?.role === "toolResult") {
      const launch = launchOf(
        message.toolCallId,
        message.toolName,
        message.details,
        message.timestamp,
      );
      if (launch !== undefined) times.set(launch.toolCallId, launch.at);
    }
  }
  return times;
}

function launchOf(
  toolCallId: string,
  toolName: string,
  details: unknown,
  at: number,
): Launch | undefined {
  if (toolName !== "bash") return undefined;
  const parsed = AsyncLaunch.safeParse(details);
  return parsed.success ? { toolCallId, jobId: parsed.data.async.jobId, at } : undefined;
}

function deliveredJobsOf(
  details: unknown,
): readonly { readonly jobId: string; readonly status?: string }[] {
  const parsed = DeliveredJobs.safeParse(details);
  return parsed.success ? parsed.data.jobs : [];
}

function viewOf(
  launch: Launch,
  deliveredStatus: string | undefined,
  process: ProcessState,
): BackgroundJobView {
  const { jobId } = launch;
  if (deliveredStatus === "failed") return { kind: "failed", jobId };
  if (deliveredStatus === "cancelled") return { kind: "cancelled", jobId };
  if (deliveredStatus !== undefined) return { kind: "finished", jobId };
  if (LIVE[process.status] !== true) return { kind: "ended", jobId };
  if (process.startedAt === undefined) return { kind: "unknown", jobId };
  return launch.at >= process.startedAt ? { kind: "running", jobId } : { kind: "ended", jobId };
}
