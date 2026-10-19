import { useMemo } from "react";
import { ToolCard } from "../U3/tool-card/card";
import type {
  ToolCardPhase,
  ToolCardState,
  ToolRenderer,
  ToolRendererProps,
} from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { splitToolResult } from "../U3/tool-card/result";
import { TextOutput } from "../U3/tool-card/text-output";
import {
  type GhToolArgs,
  GhToolArgsSchema,
  type GhToolDetails,
  GhToolDetailsSchema,
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
  const result = rendererProps.result ?? normalized.result ?? normalized.partialResult;
  const model = useMemo(
    () => decodeModel(rendererProps.args, result),
    [rendererProps.args, result],
  );
  const details = model.details;
  const args = model.args;
  const phase = phaseFor(normalized, details, model.malformed);
  const state = githubState(normalized, model, phase);
  const operation = args?.op ?? "github";
  const repository = details?.repo ?? args?.repo;

  return (
    <div data-slot="t4-github-card" data-testid={`t4-github-card-${normalized.toolCallId}`}>
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-raw']]:hidden"
        state={state}
        summary={summaryFor(operation, repository, details)}
      >
        <div className="flex min-w-0 flex-col gap-3 py-2" data-slot="t4-github-details">
          <GithubHeader
            args={args}
            details={details}
            operation={operation}
            repository={repository}
          />
          {model.resultText !== "" ? (
            <TextOutput testId="t4-github-result" text={model.resultText} />
          ) : null}
          <CheckoutPushView details={details} operation={operation} />
          <ActionsWatchView details={details} />
          <SourceLinks details={details} />
          <details className="text-muted-foreground text-xs" data-testid="t4-github-raw-details">
            <summary className="cursor-pointer font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Raw details
            </summary>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap">
              {model.rawPreview}
            </pre>
          </details>
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
  readonly resultText: string;
};

function decodeModel(argsRaw: unknown, resultRaw: unknown): GithubModel {
  const args = GhToolArgsSchema.safeParse(argsRaw);
  const split = splitToolResult(resultRaw);
  const details = GhToolDetailsSchema.safeParse(split.isEnvelope ? split.details : undefined);
  return {
    args: args.success ? args.data : undefined,
    details: details.success ? details.data : undefined,
    malformed: !args.success || (split.details !== undefined && !details.success),
    rawPreview: bounded(resultRaw),
    resultText: split.text,
  };
}

function githubState(
  normalized: ToolCardState,
  model: GithubModel,
  phase: ToolCardPhase,
): ToolCardState {
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
          ? (normalized.error ?? {
              message: safeText(model.resultText || "GitHub operation failed."),
              retryable: false,
            })
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
    repo_view: "View repository",
    file_read: "Read file",
    pr_create: "Create pull request",
    pr_checkout: "Check out pull request",
    pr_push: "Push pull request branch",
    search_issues: "Search issues",
    search_prs: "Search pull requests",
    search_code: "Search code",
    search_commits: "Search commits",
    search_repos: "Search repositories",
    run_watch: "Watch GitHub Actions",
  };
  return labels[operation] ?? "GitHub";
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
    <span
      className={`rounded-full border px-2 py-0.5 text-xs ${statusClass(status)}`}
      data-testid="t4-github-status-chip"
    >
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
  const prNumber = args?.pr;
  const query = args?.query;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="t4-github-header">
      <span
        className="border-border bg-muted text-muted-foreground rounded border px-2 py-0.5 text-sm font-medium"
        title={`GitHub operation: ${operationLabel(operation)}`}
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

function CheckoutPushView({
  details,
  operation,
}: {
  readonly details: GhToolDetails | undefined;
  readonly operation: string;
}) {
  const checkouts = details?.checkouts ?? [];
  const hasFields =
    details?.branch !== undefined ||
    details?.worktreePath !== undefined ||
    details?.remote !== undefined ||
    details?.remoteBranch !== undefined ||
    details?.headSha !== undefined ||
    checkouts.length > 0;
  if (!hasFields) return null;
  return (
    <section
      className="flex min-w-0 flex-col gap-2 p-2 text-xs"
      data-testid="t4-github-checkout-push"
    >
      <span className="font-medium">{operationLabel(operation)}</span>
      {details?.branch !== undefined ? (
        <span className="text-muted-foreground truncate">Branch: {safeText(details.branch)}</span>
      ) : null}
      {details?.worktreePath !== undefined ? (
        <span className="text-muted-foreground truncate">
          Worktree: {safeText(details.worktreePath)}
        </span>
      ) : null}
      {details?.remote !== undefined ? (
        <span className="text-muted-foreground truncate">Remote: {safeText(details.remote)}</span>
      ) : null}
      {details?.remoteBranch !== undefined ? (
        <span className="text-muted-foreground truncate">
          Remote branch: {safeText(details.remoteBranch)}
        </span>
      ) : null}
      {details?.headSha !== undefined ? (
        <code className="text-muted-foreground">{safeText(details.headSha)}</code>
      ) : null}
      {checkouts.slice(0, MAX_ROWS).map((checkout) => (
        <div
          className="flex min-w-0 flex-wrap gap-2"
          key={`${checkout.branch}:${checkout.worktreePath}`}
        >
          <span>
            {checkout.prNumber === undefined
              ? "Pull request checkout"
              : `Pull request #${checkout.prNumber}`}
          </span>
          <span className="text-muted-foreground truncate">
            Branch: {safeText(checkout.branch)}
          </span>
          <span className="text-muted-foreground truncate">
            Worktree: {safeText(checkout.worktreePath)}
          </span>
          <span className="text-muted-foreground truncate">
            Remote: {safeText(checkout.remote)}:{safeText(checkout.remoteBranch)}
          </span>
        </div>
      ))}
      {checkouts.length > MAX_ROWS ? (
        <span>
          Showing {MAX_ROWS} of {checkouts.length}
        </span>
      ) : null}
    </section>
  );
}

function ActionsWatchView({ details }: { readonly details: GhToolDetails | undefined }) {
  const watch = record(details?.watch);
  const watchRun = record(watch?.run);
  const runs = arrayOfRecords(watch?.runs ?? (watchRun === undefined ? [] : [watchRun]));
  const failedLogs = arrayOfRecords(watch?.failedLogs);
  const failedJobs = details?.failedJobs ?? [];
  const hasWatch =
    watch !== undefined ||
    details?.runId !== undefined ||
    details?.runIds !== undefined ||
    details?.status !== undefined ||
    details?.conclusion !== undefined ||
    failedJobs.length > 0;
  if (!hasWatch && failedLogs.length === 0) return null;
  return (
    <section className="flex min-w-0 flex-col gap-2 p-2" data-testid="t4-github-actions">
      {hasWatch ? <h3 className="text-sm font-medium">Actions watch</h3> : null}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {watch?.state !== undefined ? <StatusChip status={String(watch.state)} /> : null}
        {details?.status !== undefined ? <StatusChip status={details.status} /> : null}
        {details?.conclusion !== undefined ? <StatusChip status={details.conclusion} /> : null}
        {details?.runId !== undefined ? <span>Run #{details.runId}</span> : null}
        {details?.runIds && details.runIds.length > 0 ? (
          <span>
            {details.runIds.length} {details.runIds.length === 1 ? "run" : "runs"}
          </span>
        ) : null}
      </div>
      {watch?.note !== undefined ? (
        <p className="text-muted-foreground text-xs">{safeText(String(watch.note))}</p>
      ) : null}
      {runs.length > 0 ? (
        <ul className="divide-border/70 divide-y text-xs">
          {runs.slice(0, MAX_ROWS).map((run) => {
            const runJobs = arrayOfRecords(run.jobs);
            const title = text(run.workflowName) ?? text(run.displayTitle) ?? "Workflow run";
            const status = text(run.conclusion) ?? text(run.status);
            return (
              <li
                className="flex min-w-0 flex-col items-start gap-1 py-2"
                key={`${title}:${text(run.headSha) ?? ""}`}
              >
                <span className="truncate font-medium">{safeText(title)}</span>
                {status !== undefined ? <StatusChip status={status} /> : null}
                {runJobs.map((job) => {
                  const name = text(job.name) ?? "Job";
                  const jobStatus = text(job.conclusion) ?? text(job.status);
                  return (
                    <span
                      className="flex min-w-0 items-center gap-2"
                      key={`${name}:${String(job.id ?? job.url ?? jobStatus ?? "job")}`}
                    >
                      <span className="truncate">{safeText(name)}</span>
                      {jobStatus !== undefined ? <StatusChip status={jobStatus} /> : null}
                    </span>
                  );
                })}
              </li>
            );
          })}
        </ul>
      ) : null}
      {failedJobs.length > 0 ? (
        <p className="text-danger-surface-foreground text-xs" data-testid="t4-github-failed-jobs">
          Failed jobs: {failedJobs.slice(0, MAX_ROWS).map(safeText).join(", ")}
        </p>
      ) : null}
      {failedLogs.map((log) => {
        const tail = text(log.tail);
        return tail === undefined ? null : (
          <pre
            className="bg-danger-surface text-danger-surface-foreground max-h-48 overflow-auto rounded p-2 text-xs"
            data-testid="t4-github-failed-log"
            key={`${String(log.runId ?? "")}:${text(log.jobName) ?? "job"}`}
          >
            {safeText(tail)}
          </pre>
        );
      })}
    </section>
  );
}

function SourceLinks({ details }: { readonly details: GhToolDetails | undefined }) {
  const source = details?.meta?.source;
  const link = source?.type === "url" ? safeRetrievalUrl(source.value) : undefined;
  if (link === undefined) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-2 text-xs" data-testid="t4-github-source-links">
      <a
        className="text-primary underline underline-offset-2"
        href={link}
        rel="noreferrer"
        target="_blank"
      >
        Open GitHub result
      </a>
    </div>
  );
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is Record<string, unknown> => record(item) !== undefined)
        .map((item) => item as Record<string, unknown>)
    : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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
