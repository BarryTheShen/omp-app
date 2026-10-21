import { type RefObject, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ToolCardState } from "../U3/tool-card/contract";
import { useStopPress } from "../U3/tool-card/stop-press";
import type { JobStops } from "./job-stops";
import {
  type AgentActivity,
  type CancelOutcome,
  type DaemonSnapshot,
  type IrcMessage,
  type IrcReceipt,
  type JobSnapshot,
  type Peer,
  shownJobText,
} from "./models";

export const MAX_ITEMS = 20;
const MAX_TEXT = 500;
const MAX_RAW = 4_000;

/** Plain-English labels for omp's status and outcome values; the raw value stays in the tooltip. */
const STATUS_LABELS: Readonly<Record<string, string>> = {
  running: "Running",
  pending: "Pending",
  completed: "Completed",
  failed: "Failed",
  aborted: "Aborted",
  cancelled: "Cancelled",
  not_found: "Not found",
  already_completed: "Already finished",
  injected: "Delivered",
  woken: "Woke agent",
  revived: "Revived agent",
  idle: "Idle",
  parked: "Parked",
  ready: "Ready",
  starting: "Starting",
  restarting: "Restarting",
  stopping: "Stopping",
  exited: "Exited",
  stopped: "Stopped",
  dead: "Ended",
  killed: "Killed",
};

const TYPE_LABELS: Readonly<Record<string, string>> = {
  task: "Task",
  bash: "Command",
  eval: "Code",
};

const TONE_CLASSES = {
  info: "border-info/30 bg-info-surface text-info-surface-foreground",
  success: "border-success/30 bg-success-surface text-success-surface-foreground",
  danger: "border-danger/30 bg-danger-surface text-danger-surface-foreground",
  muted: "border-border bg-muted text-muted-foreground",
} as const;

type Tone = keyof typeof TONE_CLASSES;

const TONE_BY_VALUE: Readonly<Record<string, Tone>> = {
  completed: "success",
  injected: "success",
  ready: "success",
  failed: "danger",
  cancelled: "muted",
  aborted: "muted",
  not_found: "muted",
  already_completed: "muted",
  idle: "muted",
  parked: "muted",
  exited: "muted",
  stopped: "muted",
  dead: "muted",
  killed: "muted",
};

export function statusLabel(value: string): string {
  return (
    STATUS_LABELS[value] ??
    value.replace(/_/g, " ").replace(/^[a-z]/, (letter) => letter.toUpperCase())
  );
}

/** "1 job", "2 jobs": a count with its noun, pluralized. */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Job counts in a fixed order, e.g. "2 running · 1 completed"; "" when there are no jobs. */
export function jobCounts(statuses: readonly string[]): string {
  const order = ["running", "completed", "failed", "cancelled", "already_completed"] as const;
  return order
    .map((status) => ({ status, count: statuses.filter((value) => value === status).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${statusLabel(entry.status).toLowerCase()}`)
    .join(" · ");
}

export function showingNote(total: number): string | undefined {
  return total > MAX_ITEMS
    ? `Showing ${MAX_ITEMS} of ${total} · +${total - MAX_ITEMS} more`
    : undefined;
}

/** The roster totals omp reports for all agents, e.g. "1 running · 5 parked"; "" when none. */
export function peerTotals(counts: Readonly<Record<string, unknown>> | undefined): string {
  return ["running", "idle", "parked"]
    .map((status) => ({ status, count: counts?.[status] }))
    .filter(
      (entry): entry is { status: string; count: number } =>
        typeof entry.count === "number" && entry.count > 0,
    )
    .map((entry) => `${entry.count} ${entry.status}`)
    .join(" · ");
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 0 : 1)}s`;
  }
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

/** A decode failure: the card shows the failure as its error, and the raw details stay available. */
export function malformedState(state: ToolCardState, message: string): ToolCardState {
  return {
    ...state,
    phase: "error",
    isError: true,
    error: { code: "invalid_args", message, retryable: false },
  };
}

export function StatusChip({ value }: { readonly value: string }) {
  const tone = TONE_CLASSES[TONE_BY_VALUE[value] ?? "info"];
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[0.7rem] font-medium leading-tight ${tone}`}
      data-slot="t5-status"
      title={value}
    >
      {statusLabel(value)}
    </span>
  );
}

/** Text a card shows in part: its first characters, and how many were left out. */
export function Preview({ text }: { readonly text: string }) {
  const cut = text.length > MAX_TEXT;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-xs">
      <p className="whitespace-pre-wrap break-words text-muted-foreground">
        {cut ? `${text.slice(0, MAX_TEXT)}…` : text}
      </p>
      {cut && (
        <p className="text-muted-foreground">
          Showing {MAX_TEXT} of {text.length.toLocaleString("en-US")} characters
        </p>
      )}
    </div>
  );
}

export function MessageBlock({ message }: { readonly message: IrcMessage }) {
  return (
    <section className="flex min-w-0 flex-col gap-1" data-slot="t5-message">
      <h3 className="text-xs font-medium text-muted-foreground">Message</h3>
      <p className="text-xs text-muted-foreground">
        From <span className="font-medium text-foreground">{message.from}</span> to{" "}
        <span className="font-medium text-foreground">{message.to}</span>
      </p>
      <Preview text={message.body} />
    </section>
  );
}

export function RecipientRows({ receipts }: { readonly receipts: readonly IrcReceipt[] }) {
  const note = showingNote(receipts.length);
  return (
    <section className="flex min-w-0 flex-col gap-1" data-slot="t5-recipients">
      <h3 className="text-xs font-medium text-muted-foreground">Recipients</h3>
      {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
      <ul className="grid gap-2 text-xs">
        {receipts.slice(0, MAX_ITEMS).map((receipt) => (
          <li
            className="bg-muted/30 flex min-w-0 flex-wrap items-center gap-2 rounded p-2"
            key={receipt.to}
          >
            <span className="min-w-0 break-all font-medium text-foreground">{receipt.to}</span>
            <StatusChip value={receipt.outcome} />
            {receipt.error !== undefined && (
              <span className="min-w-0 break-words text-danger">{receipt.error}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The Stop control of one job row, and omp's answer to the stop asked for it. */
function JobStopLine({
  control,
  job,
  position,
  stops,
}: {
  readonly control: RefObject<HTMLButtonElement | null>;
  readonly job: JobSnapshot;
  readonly position: number;
  readonly stops: JobStops;
}) {
  const outcome = stops.outcomeOf(job);
  const stoppable = stops.canStop(job);
  if (!stoppable && outcome === undefined) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {stoppable && (
        <Button
          aria-label={`Stop background job ${position}`}
          disabled={stops.pending}
          ref={control}
          size="sm"
          type="button"
          variant="outline"
        >
          Stop
        </Button>
      )}
      {outcome !== undefined && (
        <p className="text-xs text-muted-foreground" role="status">
          {outcome.sentence}
        </p>
      )}
    </div>
  );
}

export function JobRows({
  jobs,
  stops,
}: {
  readonly jobs: readonly JobSnapshot[];
  readonly stops: JobStops;
}) {
  const note = showingNote(jobs.length);
  const stoppable = jobs.some((job) => stops.canStop(job));
  // Every job omp still runs, as the card lists them: omp's count for Stop all is checked against these.
  const running = jobs.filter((job) => stops.statusOf(job) === "running").map((job) => job.id);
  const stopAll = useStopPress(() => void stops.stopAll(running), stops.pending);
  return (
    <section className="flex min-w-0 flex-col gap-1" data-slot="t5-jobs">
      <div className="flex min-w-0 flex-wrap items-center gap-2" {...stopAll.container}>
        <h3 className="text-xs font-medium text-muted-foreground">Jobs</h3>
        {stoppable && (
          <Button
            aria-label="Stop all background jobs"
            disabled={stops.pending}
            ref={stopAll.control}
            size="sm"
            type="button"
            variant="outline"
          >
            Stop all
          </Button>
        )}
      </div>
      {stops.allOutcome !== undefined && (
        <p className="text-xs text-muted-foreground" role="status">
          {stops.allOutcome.sentence}
        </p>
      )}
      {stops.statusesAsOfCall && (
        <p className="text-xs text-muted-foreground">
          {"omp did not say which of these jobs it stopped, so their statuses may be out of date."}
        </p>
      )}
      {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
      <ul className="grid gap-2 text-xs">
        {jobs.slice(0, MAX_ITEMS).map((job, index) => (
          <JobRow index={index} job={job} key={job.id} stops={stops} />
        ))}
      </ul>
    </section>
  );
}

/** One job in the Tasks list. Its Stop control acts on a press that began on it (see useStopPress). */
function JobRow({
  index,
  job,
  stops,
}: {
  readonly index: number;
  readonly job: JobSnapshot;
  readonly stops: JobStops;
}) {
  const press = useStopPress(() => void stops.stop(job.id), stops.pending);
  return (
    <li className="bg-muted/30 flex min-w-0 flex-col gap-1 rounded p-2" {...press.container}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-all font-medium text-foreground">
          {job.label.length > 0 ? job.label : `Background job ${index + 1}`}
        </span>
        <span className="text-muted-foreground" title={job.type}>
          {TYPE_LABELS[job.type] ?? job.type}
        </span>
        <StatusChip value={stops.statusOf(job)} />
        <span className="text-muted-foreground">{formatDuration(job.durationMs)}</span>
        {job.exitCode !== undefined && (
          <span className="text-muted-foreground">Exit code {job.exitCode}</span>
        )}
        {stops.statusOf(job) === "running" && job.completionPercent !== undefined && (
          <span className="text-muted-foreground">{Math.round(job.completionPercent)}% done</span>
        )}
      </div>
      <JobStopLine control={press.control} job={job} position={index + 1} stops={stops} />
      <JobTexts job={job} />
    </li>
  );
}

/** A job's result and error, as the row shows them: the words the worker produced, with omp's envelope read away. */
function JobTexts({ job }: { readonly job: JobSnapshot }) {
  const result = shownJobText(job.resultText);
  const error = shownJobText(job.errorText);
  return (
    <>
      {result !== undefined && <Preview text={result} />}
      {error !== undefined && <Preview text={error} />}
    </>
  );
}

/** Cancel requests omp could not carry out; a cancelled job already shows in the job rows. */
export function CancelRows({ outcomes }: { readonly outcomes: readonly CancelOutcome[] }) {
  return (
    <section className="flex min-w-0 flex-col gap-1" data-slot="t5-cancelled">
      <h3 className="text-xs font-medium text-muted-foreground">Not cancelled</h3>
      <ul className="grid gap-1 text-xs">
        {outcomes.map((outcome) => (
          <li className="flex min-w-0 flex-wrap items-center gap-2" key={outcome.id}>
            <span className="min-w-0 break-all font-medium text-foreground">{outcome.id}</span>
            <StatusChip value={outcome.status} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AgentRows({ agents }: { readonly agents: readonly AgentActivity[] }) {
  const note = showingNote(agents.length);
  return (
    <section className="flex min-w-0 flex-col gap-1" data-slot="t5-agents">
      <h3 className="text-xs font-medium text-muted-foreground">Other agents</h3>
      {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
      <ul className="grid gap-2 text-xs">
        {agents.slice(0, MAX_ITEMS).map((agent) => (
          <li className="bg-muted/30 flex min-w-0 flex-col gap-1 rounded p-2" key={agent.id}>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 break-all font-medium text-foreground">{agent.id}</span>
              {agent.live ? (
                <StatusChip value="running" />
              ) : (
                <span className="text-muted-foreground">Not running</span>
              )}
              <span className="text-muted-foreground">
                {formatDuration(agent.ageMs)} since it started
              </span>
            </div>
            {agent.activity !== undefined && <Preview text={agent.activity} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The roster: each agent's status, and the totals omp reports for all agents, not only the shown ones. */
export function PeerRows({
  peers,
  counts,
}: {
  readonly peers: readonly Peer[];
  readonly counts: Readonly<Record<string, unknown>> | undefined;
}) {
  const note = showingNote(peers.length);
  const totals = peerTotals(counts);
  return (
    <section className="flex min-w-0 flex-col gap-1" data-slot="t5-peers">
      <h3 className="text-xs font-medium text-muted-foreground">
        {totals === "" ? "Agents" : `Agents · ${totals}`}
      </h3>
      {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
      <ul className="grid gap-2 text-xs">
        {peers.slice(0, MAX_ITEMS).map((peer) => (
          <li
            className="bg-muted/30 flex min-w-0 flex-wrap items-center gap-2 rounded p-2"
            key={peer.id}
          >
            <span className="min-w-0 break-all font-medium text-foreground">{peer.id}</span>
            {peer.displayName !== undefined && peer.displayName !== peer.id && (
              <span className="text-muted-foreground">{peer.displayName}</span>
            )}
            <StatusChip value={peer.status} />
            {peer.parentId !== undefined && (
              <span className="text-muted-foreground">Started by {peer.parentId}</span>
            )}
            {peer.unread !== undefined && peer.unread > 0 && (
              <span className="text-muted-foreground">
                {countOf(peer.unread, "unread message")}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DaemonRow({
  daemon,
  timedOut,
}: {
  readonly daemon: DaemonSnapshot;
  readonly timedOut: boolean | undefined;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1" data-slot="t5-service">
      <h3 className="text-xs font-medium text-muted-foreground">Service</h3>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <span className="min-w-0 break-all font-medium text-foreground">{daemon.name}</span>
        <StatusChip value={daemon.state} />
        {daemon.exitCode !== undefined && (
          <span className="text-muted-foreground">Exit code {daemon.exitCode}</span>
        )}
        {daemon.restartCount !== undefined && daemon.restartCount > 0 && (
          <span className="text-muted-foreground">{countOf(daemon.restartCount, "restart")}</span>
        )}
        {timedOut === true && <span className="text-danger">Timed out before it was ready</span>}
      </div>
    </section>
  );
}

/**
 * The arguments and the result as omp sent them, folded behind one toggle. The text is rendered only
 * once the disclosure is open, so a closed card holds no copy of the raw result for the page to find.
 */
export function RawDetails({ state }: { readonly state: ToolCardState }) {
  const [open, setOpen] = useState(false);
  const result = state.result ?? state.partialResult;
  return (
    <details
      className="mt-2 text-xs"
      data-slot="t5-raw-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-muted-foreground">Raw details</summary>
      {open && (
        <div className="mt-2 grid gap-2 rounded bg-muted/30 p-2">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
            {state.argsText}
          </pre>
          {result !== undefined && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
              {rawText(result)}
            </pre>
          )}
        </div>
      )}
    </details>
  );
}

function rawText(value: unknown): string {
  const text = stringify(value);
  return text.length > MAX_RAW ? `${text.slice(0, MAX_RAW - 1)}…` : text;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}
