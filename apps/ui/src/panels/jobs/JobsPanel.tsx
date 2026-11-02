import type { AppClient } from "@omp-app/client";
import { AppFailure } from "@omp-app/contracts";
import {
  type JobDetail,
  type JobList,
  JobListSchema,
  type JobRow,
} from "@omp-app/contracts/chat-host";
import { ChevronLeft } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ChatController } from "../../chat/controller";
import { pauseAllChats } from "../../chat/pauseAll";
import { lastSeen } from "../../lastSeen";
import { fmtDuration } from "../../vendor/collab-web/lib/format";

const failureText = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/** An app server that predates the job methods refuses them as unknown. */
const isOlderServer = (failure: unknown): boolean =>
  failure instanceof AppFailure && failure.appError.code === "invalid_args";

/** How often the tab reads the jobs while the page shows: omp emits no event for a job. */
const READ_EVERY_MS = 1_000;

const NO_JOBS: JobList = { running: [], recent: [] };

/**
 * The chat's jobs as the tab showed them last, also after a reload: shown at once, marked as updating, while the tab
 * reads them again. On a slow, relayed connection that read can wait many seconds behind the chat's history (#2785).
 */
const keptJobs = (threadId: string) =>
  lastSeen<JobList>(`jobs:${threadId}`, (stored) => {
    const parsed = JobListSchema.safeParse(stored);
    return parsed.success ? parsed.data : undefined;
  });

/** omp's word and colour for each of a job's states (its jobs sheet). */
const STATUS = {
  running: { said: "Running", dot: "bg-accent-ink" },
  completed: { said: "Done", dot: "bg-ok" },
  failed: { said: "Failed", dot: "bg-bad" },
  cancelled: { said: "Cancelled", dot: "bg-t3" },
} as const satisfies Record<JobRow["status"], unknown>;

/** How long a job ran, or has run so far. */
const ageOf = (job: JobRow, now: number): string =>
  fmtDuration((job.endTime ?? now) - job.startTime);

/** omp's line over its jobs: "2 running · 3 recent". */
function summaryOf(list: JobList): string {
  const parts: string[] = [];
  if (list.running.length > 0) parts.push(`${list.running.length} running`);
  if (list.recent.length > 0) parts.push(`${list.recent.length} recent`);
  return parts.join(" · ");
}

/** A command on one line, as omp's jobs sheet lists it. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The focused chat's background jobs, as omp's jobs sheet lists them: running, then recent. A click opens a job's
 * command and output, with Cancel job for one of the chat's own; a subagent's job opens the Agent Hub on it. omp emits
 * no event for a job, so the tab reads them every second while the page shows. Above them, Pause all and Resume all
 * hold or release every running chat (omp's `/pause` in each).
 */
export function JobsPanel({
  client,
  chat,
}: {
  readonly client: AppClient;
  readonly chat: ChatController | null;
}): ReactNode {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PauseAll client={client} />
      {chat === null ? (
        <p className="px-4 py-3 text-[0.8125rem] text-t3">
          Open a chat to see its background jobs.
        </p>
      ) : (
        <Jobs key={chat.threadId ?? "new"} chat={chat} />
      )}
    </div>
  );
}

/** Pause all and Resume all, and what the last one did. */
function PauseAll({ client }: { readonly client: AppClient }): ReactNode {
  const [said, setSaid] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const run = (paused: boolean): void => {
    setBusy(true);
    pauseAllChats(client, paused)
      .then(
        (text) => setSaid({ text, failed: false }),
        (failure: unknown) => setSaid({ text: failureText(failure), failed: true }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-1 border-b border-l2 px-4 py-2">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(true)}>
          Pause all chats
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(false)}>
          Resume all
        </Button>
      </div>
      {said !== null && (
        <p
          role={said.failed ? "alert" : "status"}
          className={said.failed ? "text-xs text-bad-ink" : "text-xs text-t3"}
        >
          {said.text}
        </p>
      )}
    </div>
  );
}

function Jobs({ chat }: { readonly chat: ChatController }): ReactNode {
  const [list, setList] = useState<JobList | undefined>(() =>
    chat.threadId === null ? undefined : keptJobs(chat.threadId).get(),
  );
  /** Whether `list` is this tab's own read, not the one kept from before. */
  const [current, setCurrent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [older, setOlder] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [openId, setOpenId] = useState<string | null>(null);
  const readNow = useRef<(() => void) | null>(null);

  useEffect(() => {
    let alive = true;
    let reading = false;
    const read = () => {
      if (reading) return;
      // A chat not sent yet has no omp, so no jobs; the next read after its first message finds them.
      if (chat.threadId === null) {
        setList(NO_JOBS);
        return;
      }
      reading = true;
      chat
        .jobs()
        .then(
          (next) => {
            if (!alive) return;
            const shown = next ?? NO_JOBS;
            setList(shown);
            setCurrent(true);
            if (chat.threadId !== null) keptJobs(chat.threadId).set(shown);
            setProblem(null);
            setNow(Date.now());
          },
          (failure: unknown) => {
            if (!alive) return;
            if (isOlderServer(failure)) setOlder(true);
            else setProblem(`Could not read the background jobs: ${failureText(failure)}`);
          },
        )
        .finally(() => {
          reading = false;
        });
    };
    readNow.current = read;
    read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") read();
    }, READ_EVERY_MS);
    return () => {
      alive = false;
      readNow.current = null;
      window.clearInterval(timer);
    };
  }, [chat]);

  const jobs = list === undefined ? [] : [...list.running, ...list.recent];
  const opened = openId === null ? undefined : jobs.find((job) => job.id === openId);
  return (
    <div data-tour="jobs-panel" className="flex min-h-0 flex-1 flex-col">
      {older ? (
        <p className="px-4 py-3 text-[0.8125rem] text-t3">
          This app server cannot list background jobs yet; it needs an update.
        </p>
      ) : list === undefined ? (
        <p className="px-4 py-3 text-[0.8125rem] text-t3">
          {problem ?? "Reading the background jobs…"}
        </p>
      ) : openId !== null ? (
        <JobView
          chat={chat}
          jobId={openId}
          job={opened}
          now={now}
          onBack={() => setOpenId(null)}
          onCancelled={() => readNow.current?.()}
        />
      ) : (
        <section aria-label="Background jobs" className="flex min-h-0 flex-col py-3">
          {jobs.length === 0 ? (
            <div className="flex flex-col gap-1 px-4">
              <p className="text-[0.8125rem] text-t2">No background jobs</p>
              <p className="text-xs text-t3">
                Commands and subagent tasks started in the background show up here while they run.
              </p>
            </div>
          ) : (
            <>
              <p className="px-4 pb-1 text-xs text-t3">
                {summaryOf(list)}
                {!current && " · updating…"}
              </p>
              <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-2">
                {jobs.map((job) => (
                  <JobItem
                    key={job.id}
                    job={job}
                    now={now}
                    onOpen={() =>
                      job.type === "task" && job.agentId !== undefined
                        ? chat.agentHub.open(job.agentId)
                        : setOpenId(job.id)
                    }
                  />
                ))}
              </ul>
            </>
          )}
          {problem !== null && (
            <p role="alert" className="px-4 pt-2 text-xs text-bad">
              {problem}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function JobItem({
  job,
  now,
  onOpen,
}: {
  readonly job: JobRow;
  readonly now: number;
  readonly onOpen: () => void;
}): ReactNode {
  const status = STATUS[job.status];
  // A command or a cell is shown in mono on one line; a subagent's task by its name.
  const mono = job.type !== "task";
  const label = mono ? oneLine(job.label) : job.label;
  const age = ageOf(job, now);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${label}: ${job.type}, ${status.said.toLowerCase()}, ${age}`}
        className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-l1 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${status.dot}`} />
          <span
            className={`min-w-0 truncate text-t1 ${mono ? "font-mono text-xs" : "text-[0.8125rem]"}`}
          >
            {label}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 pl-3.5 text-xs text-t3">
          <span className="shrink-0">{job.type}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">{status.said}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0 tabular-nums">{age}</span>
        </span>
      </button>
    </li>
  );
}

/** One fact of a job, as omp's sheet lists them: Agent, Directory, PID, Exit code, Full output. */
function Fact({
  name,
  children,
  className = "text-t1",
}: {
  readonly name: string;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactNode {
  return (
    <>
      <dt className="text-t3">{name}</dt>
      <dd className={`min-w-0 break-all ${className}`}>{children}</dd>
    </>
  );
}

/**
 * One job: its state, facts, command and output, read every second while it runs and once more as it ends; Cancel job
 * for one of the chat's own while it runs (omp's rule: a subagent's own job is the subagent's to stop).
 */
function JobView({
  chat,
  jobId,
  job,
  now,
  onBack,
  onCancelled,
}: {
  readonly chat: ChatController;
  readonly jobId: string;
  /** The job as the list has it; none once omp no longer keeps it. */
  readonly job: JobRow | undefined;
  readonly now: number;
  readonly onBack: () => void;
  readonly onCancelled: () => void;
}): ReactNode {
  const [detail, setDetail] = useState<JobDetail | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const running = job?.status === "running";

  useEffect(() => {
    let alive = true;
    let reading = false;
    const read = () => {
      if (reading) return;
      reading = true;
      chat
        .inspectJob(jobId)
        .then(
          (next) => {
            if (!alive) return;
            setDetail(next);
            setProblem(null);
          },
          (failure: unknown) => {
            if (alive) setProblem(`Could not read the job: ${failureText(failure)}`);
          },
        )
        .finally(() => {
          reading = false;
        });
    };
    read();
    // A settled job's output no longer changes: read once more as it settles, then left.
    if (!running) {
      return () => {
        alive = false;
      };
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") read();
    }, READ_EVERY_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [chat, jobId, running]);

  // The output keeps to its end while the reader is there, as a terminal does.
  const output = detail?.output;
  const outputRef = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const box = outputRef.current;
    if (output !== undefined && box !== null && atEnd.current) box.scrollTop = box.scrollHeight;
  }, [output]);

  const cancel = () => {
    setPending(true);
    setProblem(null);
    chat
      .cancelJob(jobId)
      .then(
        (cancelled) => {
          if (!cancelled) setProblem("This job no longer runs.");
          onCancelled();
        },
        (failure: unknown) => setProblem(`Could not cancel the job: ${failureText(failure)}`),
      )
      .finally(() => setPending(false));
  };

  const status = job === undefined ? undefined : STATUS[job.status];
  const command =
    detail?.command ?? (job === undefined || job.type === "task" ? undefined : job.label);
  const pids = detail?.pids ?? [];
  return (
    <section aria-label={`Job ${jobId}`} className="flex h-full min-h-0 flex-col gap-3 px-2 py-3">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 self-start rounded-md px-1.5 py-1 text-xs text-t2 outline-none hover:bg-l1 hover:text-t1 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronLeft aria-hidden className="size-3.5" />
        All jobs
      </button>
      {job === undefined || status === undefined ? (
        <p className="px-2 text-[0.8125rem] text-t3">omp no longer keeps this job.</p>
      ) : (
        <>
          <div className="flex flex-col gap-1 px-2">
            <p className="flex items-center gap-2 text-[0.8125rem] text-t1">
              <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${status.dot}`} />
              {status.said}
            </p>
            <p className="text-xs text-t3">
              {job.type} · {job.id} · <span className="tabular-nums">{ageOf(job, now)}</span>
            </p>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-2 text-xs">
            {job.agentId !== undefined && (
              <Fact name="Agent" className="font-mono text-t1">
                {job.agentId}
              </Fact>
            )}
            {detail?.cwd !== undefined && (
              <Fact name="Directory" className="font-mono text-t1">
                {detail.cwd}
              </Fact>
            )}
            {pids.length > 0 && (
              <Fact name={pids.length > 1 ? "PIDs" : "PID"} className="font-mono text-t1">
                {pids.join(", ")}
              </Fact>
            )}
            {detail?.exitCode !== undefined && (
              <Fact
                name="Exit code"
                className={`font-mono ${detail.exitCode === 0 ? "text-ok" : "text-bad"}`}
              >
                {detail.exitCode}
              </Fact>
            )}
            {detail?.artifactId !== undefined && (
              <Fact name="Full output" className="font-mono text-t1">
                artifact://{detail.artifactId}
              </Fact>
            )}
          </dl>
          {command !== undefined && (
            <pre className="max-h-32 shrink-0 overflow-auto whitespace-pre-wrap break-words rounded-md bg-l1 px-2 py-1.5 font-mono text-xs text-t1">
              {command}
            </pre>
          )}
          <div className="flex min-h-0 flex-1 flex-col gap-1">
            <p className="px-2 text-xs text-t3">
              {detail?.outputCut === true ? "Output, its last 64 KiB" : "Output"}
            </p>
            <pre
              ref={outputRef}
              onScroll={(event) => {
                const box = event.currentTarget;
                atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < 8;
              }}
              className="min-h-16 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md bg-l1 px-2 py-1.5 font-mono text-xs text-t2"
            >
              {output !== undefined && output !== ""
                ? output
                : detail === undefined
                  ? "Reading…"
                  : "No output yet."}
            </pre>
          </div>
          {running && job.own && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              disabled={pending}
              onClick={cancel}
            >
              Cancel job
            </Button>
          )}
        </>
      )}
      {problem !== null && (
        <p role="alert" className="px-2 text-xs text-bad">
          {problem}
        </p>
      )}
    </section>
  );
}
