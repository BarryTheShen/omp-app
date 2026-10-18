import { ToolCard } from "../U3/tool-card/card";
import type { ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { detailsSource, splitToolResult } from "../U3/tool-card/result";
import { TextOutput } from "../U3/tool-card/text-output";
import {
  AgentRows,
  CancelRows,
  countOf,
  DaemonRow,
  JobRows,
  jobCounts,
  MessageBlock,
  malformedState,
  PeerRows,
  peerTotals,
  RawDetails,
  RecipientRows,
  StatusChip,
  statusLabel,
} from "./coordination";
import { type JobStops, useJobStops } from "./job-stops";
import { decodeHubDetails, type HubDetails } from "./models";

/** Terminal colour and cursor codes that a log line carries; they are not shown as text. */
const ESCAPE = String.fromCharCode(27);
const TERMINAL_CODES = new RegExp(`${ESCAPE}\\[[0-9;?]*[ -/]*[@-~]`, "g");

/** Read-only hub card: the result omp returned for a send, job, roster, service or log call. */
export function HubCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const raw = rendererProps.result ?? normalized.result ?? normalized.partialResult;
  const text = raw === undefined ? "" : splitToolResult(raw).text;
  const decoded = raw === undefined ? undefined : decodeHubDetails(detailsSource(raw));
  const details = decoded?.ok === true ? decoded.value : undefined;
  const state =
    decoded?.ok === false ? malformedState(normalized, decoded.error.appError.message) : normalized;
  const stops = useJobStops();
  return (
    <div className="min-w-0" data-slot="t5-hub-card" data-testid="t5-hub-card">
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-result']]:hidden [&_[data-slot='u3-tool-card-raw']]:hidden"
        state={{ ...state, result: undefined, partialResult: undefined }}
        summary={hubSummary(details, state.isError, stops)}
      >
        <RawDetails state={state} />
        <HubBody details={details} isError={state.isError} stops={stops} text={text} />
      </ToolCard>
    </div>
  );
}

export const HubToolRenderer: ToolRenderer = (props) => <HubCard rendererProps={props} />;

function HubBody({
  details,
  isError,
  stops,
  text,
}: {
  readonly details: HubDetails | undefined;
  readonly isError: boolean;
  readonly stops: JobStops;
  readonly text: string;
}) {
  const receipts = details?.receipts ?? [];
  const jobs = details?.jobs ?? [];
  const agents = details?.agents ?? [];
  const cancelled = (details?.cancelled ?? []).filter((outcome) => outcome.status !== "cancelled");
  const hasStructure =
    details?.waited != null ||
    receipts.length > 0 ||
    jobs.length > 0 ||
    cancelled.length > 0 ||
    agents.length > 0 ||
    (details?.peers?.length ?? 0) > 0 ||
    details?.daemon !== undefined;
  const logRows = details?.terminalRows;
  return (
    <>
      {hasStructure && (
        <section className="flex min-w-0 flex-col gap-3 py-2" data-slot="t5-hub-details">
          {details?.waited ? <MessageBlock message={details.waited} /> : null}
          {receipts.length > 0 && <RecipientRows receipts={receipts} />}
          {jobs.length > 0 && <JobRows jobs={jobs} stops={stops} />}
          {cancelled.length > 0 && <CancelRows outcomes={cancelled} />}
          {agents.length > 0 && <AgentRows agents={agents} />}
          {details?.peers !== undefined && details.peers.length > 0 && (
            <PeerRows counts={details.counts} peers={details.peers} />
          )}
          {details?.daemon !== undefined && (
            <DaemonRow daemon={details.daemon} timedOut={details.timedOut} />
          )}
        </section>
      )}
      {logRows !== undefined && (
        <section className="flex min-w-0 flex-col gap-2" data-slot="t5-hub-log">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {details?.state !== undefined && <StatusChip value={details.state} />}
            {details?.cursor !== undefined && (
              <span>Log position {details.cursor.toLocaleString("en-US")}</span>
            )}
            {details?.timedOut === true && <span className="text-danger">Timed out</span>}
          </div>
          <TextOutput
            testId="t5-hub-log-text"
            text={
              logRows.length === 0
                ? "No log lines yet."
                : logRows.map((row) => row.replace(TERMINAL_CODES, "")).join("\n")
            }
          />
        </section>
      )}
      {!hasStructure && logRows === undefined && !isError && text !== "" && (
        <TextOutput testId="t5-hub-text" text={text} />
      )}
    </>
  );
}

function hubSummary(details: HubDetails | undefined, isError: boolean, stops: JobStops): string {
  if (isError) return "";
  if (details === undefined) return "Waiting for the result";
  if (details.waited) return `Message from ${details.waited.from}`;
  const receipts = details.receipts ?? [];
  if (receipts.length === 1) {
    const [receipt] = receipts;
    return receipt === undefined ? "" : `Sent to ${receipt.to} · ${statusLabel(receipt.outcome)}`;
  }
  if (receipts.length > 1) return `Sent to ${countOf(receipts.length, "recipient")}`;
  if (details.daemon !== undefined) {
    return `${details.daemon.name} · ${statusLabel(details.daemon.state)}`;
  }
  if (details.terminalRows !== undefined) {
    return details.state === undefined ? "Log output" : `Log · ${statusLabel(details.state)}`;
  }
  if (details.peers !== undefined)
    return peerTotals(details.counts) || countOf(details.peers.length, "agent");
  const jobs = details.jobs ?? [];
  if (jobs.length > 0) return jobCounts(jobs.map((job) => stops.statusOf(job)));
  const agents = details.agents ?? [];
  if (agents.length > 0) return `${countOf(agents.length, "agent")} without a job`;
  return "No details reported";
}
