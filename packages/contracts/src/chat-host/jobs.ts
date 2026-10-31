/**
 * A chat's background jobs, as omp keeps them in its job manager (18.12.6 `async/job-manager.ts`): bash commands and
 * eval cells sent to the background, and subagents run in the background (`task`). omp emits no event for a job, so the
 * Jobs tab reads them (`get_jobs`, `inspect_job`, `cancel_job`).
 */
import { z } from "zod";

export type JobType = "bash" | "task" | "eval";
export type JobStatus = "running" | "completed" | "failed" | "cancelled";

/** One job as the tab lists it: omp's snapshot row without its command (a heredoc's can be many KiB). */
export interface JobRow {
  readonly id: string;
  readonly type: JobType;
  readonly status: JobStatus;
  /** omp's label: the command cut to 120 characters, a subagent's id, or an eval cell's title. */
  readonly label: string;
  readonly startTime: number;
  readonly endTime?: number;
  /** The subagent a `task` job runs. */
  readonly agentId?: string;
  /** The chat's own job, not one of its subagents': only these can be cancelled from the chat, as in omp. */
  readonly own: boolean;
}

export interface JobList {
  readonly running: readonly JobRow[];
  /** The newest settled ones, newest first: omp keeps a settled job 5 minutes, or 30 s once its result was read. */
  readonly recent: readonly JobRow[];
}

/** What the most of a job's output a detail carries: its last 64 KiB. */
export const JOB_OUTPUT_MAX_CHARS = 64 * 1024;

/** One job's detail, read from omp's job manager. */
export interface JobDetail {
  readonly id: string;
  readonly command?: string;
  readonly cwd?: string;
  /** Its live process ids: none before it starts and after it ends. */
  readonly pids: readonly number[];
  readonly exitCode?: number;
  /** Its output, the last `JOB_OUTPUT_MAX_CHARS` of it: the tail while it runs, then its result or error. */
  readonly output?: string;
  /** Whether the output was cut to its end. */
  readonly outputCut: boolean;
  /** The artifact that keeps the full output, when omp kept one (`artifact://<id>`). */
  readonly artifactId?: string;
}

export const JobsParams = z.object({ recentLimit: z.int().min(0).max(100).optional() });
export type JobsParams = z.infer<typeof JobsParams>;

export const JobIdParams = z.object({ jobId: z.string().min(1) });
export type JobIdParams = z.infer<typeof JobIdParams>;
