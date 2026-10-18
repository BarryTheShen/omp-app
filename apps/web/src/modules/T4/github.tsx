import { useMemo } from "react";
import { ToolCard } from "../U3/tool-card/card";
import type {
  ToolCardPhase,
  ToolCardState,
  ToolRenderer,
  ToolRendererProps,
} from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import {
  type GhToolArgs,
  GhToolArgsSchema,
  type GhToolDetails,
  GhToolDetailsSchema,
  mapT4Failure,
  safeRetrievalUrl,
} from "./models";

const MAX_ROWS = 128;
const MAX_TEXT = 4_000;

export interface GithubCardProps {
  readonly rendererProps: ToolRendererProps;
}

/** Render-only GitHub card. It never calls gh, opens a URL, or performs a repository mutation. */
export function GithubCard({ rendererProps }: GithubCardProps) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const model = useMemo(
    () => decodeModel(rendererProps.args, rendererProps.result ?? normalized.result),
    [normalized.result, rendererProps.args, rendererProps.result],
  );
  const details = model.details;
  const args = model.args;
  const phase = phaseFor(normalized, details, model.malformed);
  const state = githubState(normalized, model, phase);
  const operation = details?.op ?? args?.op ?? "github";
  const repository = details?.repository ?? args?.repo;

  return (
    <div data-slot="t4-github-card" data-testid={`t4-github-card-${normalized.toolCallId}`}>
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-raw']]:hidden"
        state={state}
        summary={summaryFor(operation, repository, details)}
      >
        <details className="text-muted-foreground text-xs" data-testid="t4-github-raw-details">
          <summary className="cursor-pointer font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Raw details
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap">{model.rawPreview}</pre>
        </details>
        <div className="flex min-w-0 flex-col gap-3 py-2" data-slot="t4-github-details">
          <GithubHeader
            args={args}
            details={details}
            operation={operation}
            repository={repository}
          />
          <PullRequestView details={details} />
          <SearchRows details={details} />
          <CheckoutPushView details={details} operation={operation} />
          <ActionsWatchView details={details} />
          <SourceLinks details={details} />
        </div>
      </ToolCard>
    </div>
  );
}

export const GithubToolRenderer: ToolRenderer = (props) => <GithubCard rendererProps={props} />;

type GithubModel = {
  readonly args: GhToolArgs | undefined;
  readonly details: GhToolDetails | undefined;
  readonly malformed: boolean;
  readonly rawPreview: string;
};

function decodeModel(argsRaw: unknown, resultRaw: unknown): GithubModel {
  const args = GhToolArgsSchema.safeParse(argsRaw);
  const resultRecord = record(resultRaw);
  const detailsRaw = resultRecord?.details ?? resultRaw;
  const details = GhToolDetailsSchema.safeParse(detailsRaw);
  return {
    args: args.success ? args.data : undefined,
    details: details.success ? details.data : undefined,
    // A call with no result has no details to decode: it is unrecorded, not malformed.
    malformed: !args.success || (resultRaw !== undefined && !details.success),
    rawPreview: bounded(resultRaw),
  };
}

function githubState(
  normalized: ToolCardState,
  model: GithubModel,
  phase: ToolCardPhase,
): ToolCardState {
  const rawError = model.details?.error;
  const error =
    phase === "cancelled"
      ? { code: "cancelled" as const, message: "GitHub operation cancelled.", retryable: false }
      : model.malformed
        ? {
            code: "invalid_args" as const,
            message: "GitHub details were malformed; raw output is retained.",
            retryable: false,
          }
        : phase === "error"
          ? errorFor(rawError, model.details?.failedLogTail)
          : undefined;
  return {
    ...normalized,
    phase,
    result: undefined,
    partialResult: undefined,
    isError: phase === "error",
    ...(error === undefined ? {} : { error }),
    ...(phase === "cancelled" ? { cancelled: true } : {}),
  };
}

function errorFor(raw: unknown, failedLogTail: string | undefined): ToolCardState["error"] {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return {
      code: "omp_error",
      message: safeText(failedLogTail === undefined ? raw : `${raw}: ${failedLogTail}`),
      retryable: false,
    };
  }
  const failure = mapT4Failure(raw, failedLogTail ?? "GitHub operation failed.");
  return {
    code: failure.appError.code,
    message: failure.appError.message,
    retryable: failure.appError.retryable,
    timeout: failure.appError.code === "timeout",
  };
}

function phaseFor(
  normalized: ToolCardState,
  details: GhToolDetails | undefined,
  malformed: boolean,
): ToolCardPhase {
  if (normalized.phase === "cancelled") return "cancelled";
  if (malformed || normalized.phase === "error") return "error";
  const status = details?.status?.toLowerCase();
  const conclusion = details?.conclusion?.toLowerCase();
  if (
    status === "failed" ||
    status === "error" ||
    conclusion === "failure" ||
    conclusion === "cancelled"
  ) {
    return conclusion === "cancelled" ? "cancelled" : "error";
  }
  return normalized.phase;
}

function summaryFor(
  operation: string,
  repository: string | undefined,
  details: GhToolDetails | undefined,
): string {
  const branch = details?.branch;
  return [repository ?? "GitHub", operationLabel(operation), branch].filter(Boolean).join(" · ");
}

function operationLabel(operation: string): string {
  const labels: Record<string, string> = {
    repo_view: "Repository",
    file_read: "File",
    pr_create: "Pull request",
    pr_checkout: "Checkout",
    pr_push: "Push",
    search_issues: "Issue search",
    search_prs: "Pull request search",
    search_code: "Code search",
    search_commits: "Commit search",
    search_repos: "Repository search",
    run_watch: "Actions run",
  };
  return labels[operation] ?? "GitHub";
}
function stateLabel(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized === "open") return "Open";
  if (normalized === "closed") return "Closed";
  if (normalized === "merged") return "Merged";
  return safeText(state);
}

function stateClass(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized === "open" || normalized === "merged") {
    return "border-success/30 bg-success-surface text-success-surface-foreground";
  }
  if (normalized === "closed") {
    return "border-danger/30 bg-danger-surface text-danger-surface-foreground";
  }
  return "border-border bg-muted text-muted-foreground";
}
function statusLabel(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "in_progress" || normalized === "running") return "In progress";
  if (normalized === "queued" || normalized === "pending") return "Queued";
  if (normalized === "success" || normalized === "completed") return "Success";
  if (normalized === "failure" || normalized === "failed" || normalized === "error")
    return "Failure";
  if (normalized === "cancelled" || normalized === "canceled") return "Cancelled";
  return safeText(status);
}

function statusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (
    normalized === "in_progress" ||
    normalized === "running" ||
    normalized === "queued" ||
    normalized === "pending"
  ) {
    return "border-info/30 bg-info-surface text-info-surface-foreground";
  }
  if (normalized === "success" || normalized === "completed") {
    return "border-success/30 bg-success-surface text-success-surface-foreground";
  }
  if (normalized === "failure" || normalized === "failed" || normalized === "error") {
    return "border-danger/30 bg-danger-surface text-danger-surface-foreground";
  }
  return "border-border bg-muted text-muted-foreground";
}

function StatusChip({ status }: { readonly status: string }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs ${statusClass(status)}`}>
      {statusLabel(status)}
    </span>
  );
}

function GithubHeader({
  args,
  details,
  operation,
  repository,
}: {
  readonly args: GhToolArgs | undefined;
  readonly details: GhToolDetails | undefined;
  readonly operation: string;
  readonly repository: string | undefined;
}) {
  const pr = record(details?.pullRequest);
  const prNumber = pr?.number ?? args?.pr;
  const query = args?.query;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="t4-github-header">
      <span
        className="border-border bg-muted text-muted-foreground rounded border px-2 py-0.5 text-sm font-medium"
        title={`GitHub operation: ${operation}`}
      >
        {operationLabel(operation)}
      </span>
      <span className="min-w-0 truncate text-sm font-medium">{repository ?? "GitHub"}</span>
      {details?.branch !== undefined && (
        <span className="text-muted-foreground text-xs">{safeText(details.branch)}</span>
      )}
      {prNumber !== undefined && (
        <span className="text-muted-foreground text-xs">PR #{String(prNumber)}</span>
      )}
      {query !== undefined && (
        <span className="text-muted-foreground min-w-0 truncate text-xs">{safeText(query)}</span>
      )}
    </div>
  );
}

function PullRequestView({ details }: { readonly details: GhToolDetails | undefined }) {
  const pullRequest = record(details?.pullRequest);
  const diff = record(details?.diff) ?? record(pullRequest?.diff);
  if (pullRequest === undefined && diff === undefined) return null;
  const title = text(pullRequest?.title);
  const state = text(pullRequest?.state);
  const additions = number(diff?.additions ?? pullRequest?.additions);
  const deletions = number(diff?.deletions ?? pullRequest?.deletions);
  const changedFiles = number(diff?.changedFiles ?? pullRequest?.changedFiles);
  const allFiles = arrayOfRecords(diff?.files ?? pullRequest?.files);
  const files = allFiles.slice(0, MAX_ROWS);
  return (
    <section className="flex min-w-0 flex-col gap-2 p-2" data-testid="t4-github-pr">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="min-w-0 truncate text-sm font-medium">{title ?? "Pull request"}</h3>
        {state !== undefined && (
          <span className={`rounded-full border px-2 py-0.5 text-xs ${stateClass(state)}`}>
            {stateLabel(state)}
          </span>
        )}
      </div>
      {(additions !== undefined || deletions !== undefined || changedFiles !== undefined) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {additions !== undefined && (
            <span className="text-diff-add-foreground bg-diff-add-surface rounded px-2 py-1">
              +{additions}
            </span>
          )}
          {deletions !== undefined && (
            <span className="text-diff-remove-foreground bg-diff-remove-surface rounded px-2 py-1">
              −{deletions}
            </span>
          )}
          {changedFiles !== undefined && (
            <span className="text-muted-foreground rounded bg-muted px-2 py-1">
              {changedFiles} {changedFiles === 1 ? "file" : "files"}
            </span>
          )}
        </div>
      )}
      {files.length > 0 && (
        <ul
          className="divide-border/70 max-h-56 overflow-auto divide-y text-xs"
          data-testid="t4-github-files"
        >
          {files.map((file) => (
            <li
              className="flex min-w-0 items-center justify-between gap-2 py-1.5"
              key={`${text(file.path) ?? "file"}:${text(file.status) ?? "changed"}`}
            >
              <span className="min-w-0 truncate font-mono">
                {safeText(text(file.path) ?? "changed file")}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {file.status === undefined ? "changed" : safeText(String(file.status))}
              </span>
            </li>
          ))}
          {allFiles.length > files.length && (
            <li className="text-muted-foreground py-1.5">+{allFiles.length - files.length} more</li>
          )}
        </ul>
      )}
    </section>
  );
}

function SearchRows({ details }: { readonly details: GhToolDetails | undefined }) {
  const source = detailsRecordArray(details, ["results", "issues", "pullRequests", "files"]);
  if (source.length === 0) return null;
  return (
    <section className="flex min-w-0 flex-col gap-2 p-2" data-testid="t4-github-search-results">
      <h3 className="text-sm font-medium">
        {source.length} {source.length === 1 ? "result" : "results"}
      </h3>
      <ul className="divide-border/70 max-h-64 overflow-auto divide-y text-xs">
        {source.slice(0, MAX_ROWS).map((item) => (
          <li
            className="flex min-w-0 flex-col gap-0.5 py-2"
            key={`${text(item.title) ?? text(item.name) ?? "result"}:${text(item.repository) ?? ""}`}
          >
            <span className="truncate font-medium">
              {safeText(text(item.title) ?? text(item.name) ?? "GitHub result")}
            </span>
            {text(item.repository) !== undefined && (
              <span className="text-muted-foreground truncate">
                {safeText(text(item.repository) ?? "")}
              </span>
            )}
            {text(item.snippet) !== undefined && (
              <span className="text-muted-foreground line-clamp-2">
                {safeText(text(item.snippet) ?? "")}
              </span>
            )}
          </li>
        ))}
      </ul>
      {source.length > MAX_ROWS && (
        <span className="text-muted-foreground text-xs">
          Showing {MAX_ROWS} of {source.length}
        </span>
      )}
    </section>
  );
}

function CheckoutPushView({
  details,
  operation,
}: {
  readonly details: GhToolDetails | undefined;
  readonly operation: string;
}) {
  const worktree = record(details?.worktree);
  const remote = record(details?.remote);
  if (worktree === undefined && remote === undefined && details?.headSha === undefined) return null;
  return (
    <section
      className="flex min-w-0 flex-wrap gap-2 p-2 text-xs"
      data-testid="t4-github-checkout-push"
    >
      <span className="font-medium">{operationLabel(operation)}</span>
      {worktree !== undefined && (
        <span className="text-muted-foreground truncate">
          worktree {safeText(text(worktree.path) ?? "updated")}
        </span>
      )}
      {remote !== undefined && (
        <span className="text-muted-foreground truncate">
          remote {safeText(text(remote.name) ?? text(remote.url) ?? "updated")}
        </span>
      )}
      {details?.headSha !== undefined && (
        <code className="text-muted-foreground">{safeText(details.headSha)}</code>
      )}
    </section>
  );
}

function ActionsWatchView({ details }: { readonly details: GhToolDetails | undefined }) {
  const run = record(details?.run);
  const jobs = details?.jobs?.slice(0, MAX_ROWS) ?? [];
  const hasWatch = run !== undefined || jobs.length > 0;
  const runStatus = run === undefined ? undefined : (text(run.conclusion) ?? text(run.status));
  if (!hasWatch && details?.failedLogTail === undefined) return null;
  return (
    <section className="flex min-w-0 flex-col gap-2 p-2" data-testid="t4-github-actions">
      {hasWatch && <h3 className="text-sm font-medium">Actions watch</h3>}
      {run !== undefined && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {text(run.name) !== undefined && <span>{safeText(text(run.name) ?? "run")}</span>}
          {runStatus !== undefined && <StatusChip status={runStatus} />}
        </div>
      )}
      {jobs.length > 0 && (
        <ul className="divide-border/70 divide-y text-xs">
          {jobs.map((job) => (
            <li
              className="flex min-w-0 flex-wrap items-center gap-2 py-1.5"
              key={`${text(job.name) ?? "job"}:${text(job.status) ?? "unknown"}`}
            >
              <span className="min-w-0 truncate">{safeText(text(job.name) ?? "Job")}</span>
              <StatusChip status={text(job.conclusion) ?? text(job.status) ?? "unknown"} />
            </li>
          ))}
        </ul>
      )}
      {details?.failedLogTail !== undefined && (
        <>
          <h3 className="text-sm font-medium">Log</h3>
          <pre
            className="bg-danger-surface text-danger-surface-foreground max-h-48 overflow-auto rounded p-2 text-xs"
            data-testid="t4-github-failed-log"
          >
            {safeText(details.failedLogTail)}
          </pre>
        </>
      )}
    </section>
  );
}

function SourceLinks({ details }: { readonly details: GhToolDetails | undefined }) {
  const links =
    details?.sourceLinks
      ?.map(safeRetrievalUrl)
      .filter((link): link is string => link !== undefined) ?? [];
  if (links.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-2 text-xs" data-testid="t4-github-source-links">
      {links.slice(0, MAX_ROWS).map((link) => (
        <a
          className="text-primary underline underline-offset-2"
          href={link}
          key={link}
          rel="noreferrer"
          target="_blank"
        >
          {safeText(link)}
        </a>
      ))}
    </div>
  );
}

function detailsRecordArray(
  details: GhToolDetails | undefined,
  keys: readonly string[],
): Record<string, unknown>[] {
  const record = detailsRecord(details);
  if (record === undefined) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return arrayOfRecords(value);
  }
  return [];
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is Record<string, unknown> => record(item) !== undefined)
        .map((item) => item as Record<string, unknown>)
    : [];
}

function detailsRecord(details: GhToolDetails | undefined): Record<string, unknown> | undefined {
  return record(details);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeText(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) continue;
    output += character;
    if (output.length >= MAX_TEXT) break;
  }
  return output;
}
function bounded(value: unknown): string {
  try {
    const raw = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
    return safeText(raw);
  } catch {
    return "[unavailable GitHub result]";
  }
}
