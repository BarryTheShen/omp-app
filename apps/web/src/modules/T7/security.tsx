import { ToolCard } from "../U3/tool-card/card";
import type { ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import {
  decodeSecurityScan,
  decodeSecurityScanArgs,
  type SecurityScanArgs,
  type SecurityScanDetails,
} from "./models";

const MAX_CONFIGURATIONS = 20;

const CHIP = "shrink-0 rounded-full border px-2 py-0.5 text-[0.7rem] font-medium leading-tight";
const TONES = {
  danger: "border-danger/30 bg-danger-surface text-danger-surface-foreground",
  warning: "border-warning/30 bg-warning-surface text-warning-surface-foreground",
  success: "border-success/30 bg-success-surface text-success-surface-foreground",
  muted: "border-border bg-muted text-muted-foreground",
} as const;

const PHASE_LABELS = {
  queued: "Queued",
  preparing: "Preparing",
  reviewing: "Reviewing code",
  publishing: "Publishing results",
  completed: "Completed",
  partial: "Partly completed",
  cancelled: "Cancelled",
  failed: "Failed",
} as const satisfies Record<
  NonNullable<NonNullable<SecurityScanDetails["operation"]>["phase"]>,
  string
>;

const VALIDATION = {
  unvalidated: { label: "Not validated", tone: "muted" },
  validated: { label: "Confirmed", tone: "danger" },
  partial: { label: "Partly confirmed", tone: "warning" },
  rejected: { label: "Rejected", tone: "success" },
  error: { label: "Validation failed", tone: "danger" },
} as const satisfies Record<
  NonNullable<NonNullable<SecurityScanDetails["finding"]>["validationStatus"]>,
  { readonly label: string; readonly tone: keyof typeof TONES }
>;

const SEVERITIES = [
  { key: "critical", label: "critical", tone: "danger" },
  { key: "high", label: "high", tone: "danger" },
  { key: "medium", label: "medium", tone: "warning" },
  { key: "low", label: "low", tone: "muted" },
  { key: "informational", label: "info", tone: "muted" },
] as const;

export function SecurityScanCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const normalized = normalizeToolRendererProps(rendererProps);
  // The header already names the action and target; the card's raw details stay behind its disclosure.
  const state = normalized;
  const output = state.result ?? state.partialResult;
  // omp results carry structured data under `details`; bare detail objects pass through.
  const decoded = decodeSecurityScan(
    output !== null && typeof output === "object" && "details" in output ? output.details : output,
  );
  const details = decoded.ok ? decoded.value : undefined;
  const requested = decodeSecurityScanArgs(state.args);
  const args = requested.ok ? requested.value : undefined;

  return (
    <div data-testid={`t7-security-card-${state.toolCallId}`}>
      <ToolCard
        rawResult={rawText(output)}
        state={state}
        summary={oneLine(scanSummary(args, details), 96)}
      >
        {!decoded.ok && state.phase === "success" && (
          <p className="text-muted-foreground py-1 text-xs">Scan details unavailable.</p>
        )}
        {details !== undefined && (
          <ScanDetails details={details} toolFailed={state.phase === "error"} />
        )}
      </ToolCard>
    </div>
  );
}

export const SecurityScanToolRenderer: ToolRenderer = (props) => (
  <SecurityScanCard rendererProps={props} />
);

function ScanDetails({
  details,
  toolFailed,
}: {
  readonly details: SecurityScanDetails;
  readonly toolFailed: boolean;
}) {
  const { plan, operation, finding, cloudConfigurations, cloudStats, cloudScan, importedScan } =
    details;
  const configurations = cloudConfigurations ?? [];
  const severities = SEVERITIES.flatMap((severity) => {
    const count = cloudStats?.findingCounts?.[severity.key] ?? 0;
    return count > 0 ? [{ ...severity, count }] : [];
  });

  return (
    <div className="text-muted-foreground flex min-w-0 flex-col gap-1 py-1 text-xs">
      {plan !== undefined && <p>Scan plan is ready to start.</p>}
      {operation !== undefined &&
        (operation.phase !== undefined || operation.findingCount !== undefined) && (
          <p data-testid="t7-security-operation">
            {[
              operation.phase === undefined ? undefined : PHASE_LABELS[operation.phase],
              operation.findingCount === undefined
                ? undefined
                : count(operation.findingCount, "finding"),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      {operation?.error?.trim() && !toolFailed && (
        <p className="text-destructive font-medium">{oneLine(operation.error, 160)}</p>
      )}
      {details.cancelled === true && <p>Cancellation requested.</p>}
      {details.cancelled === false && <p>The scan was not running.</p>}
      {finding?.validationStatus !== undefined && (
        <p className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className="text-foreground truncate"
            {...(finding.id === undefined ? {} : { "data-finding-id": finding.id })}
          >
            Finding 1
          </span>
          <span className={`${CHIP} ${TONES[VALIDATION[finding.validationStatus].tone]}`}>
            {VALIDATION[finding.validationStatus].label}
          </span>
        </p>
      )}
      {cloudConfigurations !== undefined && configurations.length === 0 && (
        <p>No cloud scans are set up.</p>
      )}
      {configurations.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-1">
          {configurations.slice(0, MAX_CONFIGURATIONS).map((item, index) => (
            <li className="flex min-w-0 items-center gap-2" key={item.id ?? index}>
              <span className="text-foreground min-w-0 truncate">
                {item.repositoryUrl ?? item.id ?? "Cloud scan"}
              </span>
              {(item.currentStep ?? item.state) && (
                <span className="shrink-0">{readable(item.currentStep ?? item.state ?? "")}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {configurations.length > MAX_CONFIGURATIONS && (
        <p>
          Showing {MAX_CONFIGURATIONS} of {configurations.length}
        </p>
      )}
      {cloudStats !== undefined && (
        <>
          <p>
            {[
              cloudStats.currentStep ? readable(cloudStats.currentStep) : undefined,
              cloudStats.finishedCommits === undefined
                ? undefined
                : `${count(cloudStats.finishedCommits, "commit")} scanned`,
              cloudStats.pendingCommits
                ? `${cloudStats.pendingCommits.toLocaleString()} pending`
                : undefined,
              cloudStats.failedCommits
                ? `${cloudStats.failedCommits.toLocaleString()} failed`
                : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {severities.length === 0 ? (
            <p>No findings so far.</p>
          ) : (
            <p className="flex flex-wrap gap-1" data-testid="t7-security-severities">
              {severities.map((severity) => (
                <span className={`${CHIP} ${TONES[severity.tone]}`} key={severity.key}>
                  {severity.count.toLocaleString()} {severity.label}
                </span>
              ))}
            </p>
          )}
        </>
      )}
      {cloudScan !== undefined && (
        <p>
          {cloudScan.repositoryUrl
            ? `Cloud scan started for ${cloudScan.repositoryUrl}.`
            : "Cloud scan started."}{" "}
          It uses your cloud scan allowance.
        </p>
      )}
      {(cloudScan !== undefined || cloudStats !== undefined) && (
        <p>Results stay in Codex Security cloud until you import them.</p>
      )}
      {importedScan !== undefined && (
        <p>
          {importedScan.findingCount === undefined
            ? "Imported cloud findings."
            : `Imported ${count(importedScan.findingCount, "finding")}.`}{" "}
          Review imported findings with /security.
        </p>
      )}
    </div>
  );
}

function scanSummary(
  args: SecurityScanArgs | undefined,
  details: SecurityScanDetails | undefined,
): string {
  switch (args?.action ?? details?.action) {
    case "preflight":
      return `Plan a scan of ${scanTarget(args)}`;
    case "start":
      return "Start security scan";
    case "status":
      return "Check scan progress";
    case "cancel":
      return "Cancel security scan";
    case "validate": {
      const id = args?.finding_id ?? details?.finding?.id;
      return id ? `Validate finding ${id}` : "Validate a finding";
    }
    case "cloud_scans":
      return "List cloud scans";
    case "cloud_start": {
      const url = args?.repository_url ?? details?.cloudScan?.repositoryUrl;
      return url ? `Start cloud scan of ${url}` : "Start cloud scan";
    }
    case "cloud_status":
      return "Check cloud scan";
    case "cloud_pull":
      return "Import cloud findings";
    case undefined:
      return "Security scan";
  }
}

function scanTarget(args: SecurityScanArgs | undefined): string {
  const paths = args?.include_paths ?? [];
  if (args?.target_kind === "scoped_path" && paths.length > 0) {
    return paths.length > 3
      ? `${paths.slice(0, 3).join(", ")} +${paths.length - 3} more`
      : paths.join(", ");
  }
  if (args?.target_kind === "ref_diff") {
    return args.base_revision && args.head_revision
      ? `changes from ${args.base_revision} to ${args.head_revision}`
      : "branch changes";
  }
  if (args?.target_kind === "working_tree") return "uncommitted changes";
  return "the repository";
}

function count(value: number, noun: string): string {
  return `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
}

/** Cloud step names arrive as snake_case words; show them as a sentence-case phrase. */
function readable(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

function oneLine(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function rawText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "[Unserializable security scan result]";
  }
}
