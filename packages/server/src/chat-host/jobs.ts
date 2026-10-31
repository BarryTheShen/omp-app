/**
 * The chat's background jobs for the app's Jobs tab, from omp's job manager (18.12.6): the list (`getAsyncJobTree`),
 * one job's detail, and a cancel of the chat's own job (`cancelAsyncJob`). The detail is read as omp's
 * `inspectAsyncJob` reads it, but without the job's widget: reading a widget marks it shown, which can make omp ask a
 * model to draw it.
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
  JOB_OUTPUT_MAX_CHARS,
  type JobDetail,
  type JobList,
  type JobRow,
} from "@omp-app/contracts/chat-host";

type JobTree = NonNullable<ReturnType<AgentSession["getAsyncJobTree"]>>;
type JobItem = JobTree["running"][number];

/** How many settled jobs the list carries, as omp's own tree does by default. */
const RECENT_JOBS = 10;

function rowOf(item: JobItem, rootId: string | undefined): JobRow {
  return {
    id: item.id,
    type: item.type,
    status: item.status,
    label: item.label,
    startTime: item.startTime,
    ...(item.endTime === undefined ? {} : { endTime: item.endTime }),
    ...(item.agentId === undefined ? {} : { agentId: item.agentId }),
    own: item.ownerId === rootId,
  };
}

/** The chat's jobs, running and recent, its subagents' too; null when the session has no job manager. */
export function listJobs(session: AgentSession, recentLimit = RECENT_JOBS): JobList | null {
  const tree = session.getAsyncJobTree({ recentLimit });
  if (tree === null) return null;
  return {
    running: tree.running.map((item) => rowOf(item, tree.rootId)),
    recent: tree.recent.map((item) => rowOf(item, tree.rootId)),
  };
}

/** One job of the chat's tree, as omp's `inspectAsyncJob` reads it but its widget; null when the chat has no such job. */
export function inspectJob(session: AgentSession, jobId: string): JobDetail | null {
  const tree = session.getAsyncJobTree({ recentLimit: 100 });
  const listed =
    tree !== null && [...tree.running, ...tree.recent].some((item) => item.id === jobId);
  const job = listed ? session.asyncJobManager?.getJob(jobId) : undefined;
  if (job === undefined || job.foreground) return null;
  const details = job.latestDetails;
  const reported = typeof details?.exitCode === "number" ? details.exitCode : undefined;
  // omp: bash reports only non-zero exits; a completed command exited 0.
  const exitCode = reported ?? (job.type === "bash" && job.status === "completed" ? 0 : undefined);
  const output =
    job.status === "running"
      ? job.progressText
      : (job.resultText ?? job.errorText ?? job.progressText);
  const cut = output !== undefined && output.length > JOB_OUTPUT_MAX_CHARS;
  const artifactId = details?.meta?.truncation?.artifactId;
  return {
    id: job.id,
    ...(job.process?.command === undefined ? {} : { command: job.process.command }),
    ...(job.process?.cwd === undefined ? {} : { cwd: job.process.cwd }),
    pids: job.status === "running" ? (job.process?.pids() ?? []) : [],
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(output === undefined
      ? {}
      : { output: cut ? output.slice(output.length - JOB_OUTPUT_MAX_CHARS) : output }),
    outputCut: cut,
    ...(artifactId === undefined ? {} : { artifactId }),
  };
}

/** Cancels one of the chat's own running jobs; false for a subagent's, a settled or an unknown one (omp's rule). */
export function cancelJob(session: AgentSession, jobId: string): boolean {
  return session.cancelAsyncJob(jobId);
}
