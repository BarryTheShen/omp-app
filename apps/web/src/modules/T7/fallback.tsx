import { Fragment, useState } from "react";
import { Button } from "../../components/ui/button";
import { Icons } from "../../tokens";
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
import { decodeHostTool, decodeHostUri } from "./models";

const LONG_STRING_LIMIT = 240;

/** A call with no result recorded gets its one line; a finished call's chip already says Complete. */
const SETTLED_SUMMARY: Partial<Record<ToolCardPhase, string>> = {
  unrecorded: "No result recorded",
};

/** Name prefixes of MCP tools: omp v18.6.1 mints `mcp__<server>_<tool>` (`packages/tui/src/tools/mcp.ts`); sessions also record `xd__mcp__`. */
const MCP_TOOL_NAME_PREFIXES = ["mcp__", "xd__mcp__"] as const;

function safeLabel(state: ToolCardState): string {
  if (state.toolName === "host_tool" || state.toolName === "host_uri") return "Host request";
  if (
    state.toolName === "mcp" ||
    MCP_TOOL_NAME_PREFIXES.some((prefix) => state.toolName.startsWith(prefix))
  )
    return "MCP tool";
  return state.label || "Custom tool";
}

function hostStatus(props: ToolRendererProps, state: ToolCardState): string | undefined {
  const raw = state.result ?? state.partialResult ?? props.result;
  if (state.toolName === "host_tool") {
    const decoded = decodeHostTool(raw);
    if (decoded.ok && decoded.value.status) return `Host tool: ${decoded.value.status}`;
  }
  if (state.toolName === "host_uri") {
    const decoded = decodeHostUri(raw);
    if (decoded.ok && decoded.value.status) return `Host URI: ${decoded.value.status}`;
  }
  return undefined;
}

function unavailableReason(props: ToolRendererProps, state: ToolCardState): string | undefined {
  const raw = state.result ?? state.partialResult ?? props.result;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  if (!("capability" in raw) || typeof raw.capability !== "string") return undefined;
  if (!(("available" in raw && raw.available === false) || state.phase === "error"))
    return undefined;
  return "reason" in raw && typeof raw.reason === "string"
    ? raw.reason
    : `${raw.capability} is unavailable.`;
}

function JsonTree({
  value,
  label = "value",
  depth = 0,
}: {
  readonly value: unknown;
  readonly label?: string;
  readonly depth?: number;
}) {
  if (typeof value === "string") {
    const long = value.length > LONG_STRING_LIMIT;
    const text = long ? `${value.slice(0, LONG_STRING_LIMIT)}…` : value;
    if (long) {
      return (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground" title="string">
            <span>{label}</span>{" "}
            <span className="font-mono">long string ({value.length} chars)</span>
          </summary>
          <pre className="text-foreground mt-1 max-w-full overflow-auto whitespace-pre-wrap break-words">
            {text}
          </pre>
        </details>
      );
    }
    return (
      <p className="text-xs" title="string">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground ms-2 font-mono">{text}</span>
      </p>
    );
  }
  if (value === null || typeof value !== "object") {
    return (
      <p className="text-xs" title={value === null ? "null" : typeof value}>
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground ms-2 font-mono">{String(value)}</span>
      </p>
    );
  }
  if (depth > 6) return <p className="text-xs text-muted-foreground">{label}: [depth limit]</p>;
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value);
  return (
    <details className="text-xs" open={depth === 0}>
      <summary className="cursor-pointer text-muted-foreground">
        {label}: {Array.isArray(value) ? "array" : "object"}
      </summary>
      <div className="border-border/70 ms-2 mt-1 space-y-1 border-s-2 ps-2">
        {entries.map(([key, child]) => (
          <JsonTree depth={depth + 1} key={key} label={key} value={child} />
        ))}
      </div>
    </details>
  );
}

function SafeDetails({
  props,
  state,
}: {
  readonly props: ToolRendererProps;
  readonly state: ToolCardState;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const rawArgs = props.args;
  const rawResult = state.result ?? state.partialResult ?? props.result;
  // omp's text for the call, when its result carries one: it is what a person came to read.
  const text = splitToolResult(rawResult).text;
  const unavailable = unavailableReason(props, state);
  const artifact = state.outputMeta?.artifactId ?? state.outputMeta?.truncation?.artifactId;
  return (
    <section className="min-w-0" data-testid="t7-fallback-details">
      {unavailable && (
        <span
          className="border-warning/30 bg-warning-surface text-warning-surface-foreground inline-flex rounded-full border px-2 py-0.5 text-xs font-medium"
          data-testid="t7-unavailable-chip"
        >
          Unavailable
        </span>
      )}
      {artifact && <p className="text-muted-foreground text-xs">Artifact available: {artifact}</p>}
      <ArgumentRows args={rawArgs} />
      {text !== "" && <TextOutput testId="t7-fallback-text" text={text} />}
      {text === "" && rawResult !== undefined && <JsonTree label="Result" value={rawResult} />}
      <Button
        className="mt-2"
        size="xs"
        type="button"
        variant="ghost"
        onClick={() => setShowRaw((current) => !current)}
      >
        <Icons.info aria-hidden="true" />
        {showRaw ? "Hide raw details" : "Show raw details"}
      </Button>
      {showRaw && (
        <div className="border-border bg-muted/40 mt-2 max-h-56 overflow-auto rounded border p-2">
          <JsonTree label="Raw details" value={{ args: rawArgs, result: rawResult }} />
        </div>
      )}
    </section>
  );
}

/** The call's arguments, one name and value per row, so a person reads what the tool was given. */
function ArgumentRows({ args }: { readonly args: unknown }) {
  if (args === undefined || args === null) return null;
  if (typeof args !== "object" || Array.isArray(args)) {
    return (
      <p className="font-mono text-xs break-words" data-testid="t7-fallback-arguments">
        {shortValue(args)}
      </p>
    );
  }
  const entries = Object.entries(args);
  if (entries.length === 0) return null;
  return (
    <div className="mb-2 flex min-w-0 flex-col gap-1" data-testid="t7-fallback-arguments">
      <p className="text-xs font-medium text-muted-foreground">Arguments</p>
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {entries.map(([name, value]) => (
          <Fragment key={name}>
            <dt className="text-muted-foreground">{name}</dt>
            <dd className="text-foreground min-w-0 font-mono break-words">{shortValue(value)}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

/** A value as one line: a string as it is, a structure as compact JSON; a long one is cut and says how long it was. */
function shortValue(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null
        ? JSON.stringify(value)
        : String(value);
  return text.length > LONG_STRING_LIMIT
    ? `${text.slice(0, LONG_STRING_LIMIT)}… [${text.length} chars]`
    : text;
}

/** T7's one fallback renderer for unknown/custom/MCP/host calls; it never executes a call. */
export const T7ToolFallback: ToolRenderer = (props) => {
  const normalized = normalizeToolRendererProps(props);
  const correlation = hostStatus(props, normalized);
  const unavailable = unavailableReason(props, normalized);
  const state =
    correlation?.toLowerCase().endsWith("cancelled") === true
      ? {
          ...normalized,
          phase: "cancelled" as const,
          cancelled: true,
          isError: false,
          error: { message: "Host request cancelled.", retryable: false },
          defaultOpen: true,
        }
      : unavailable !== undefined
        ? {
            ...normalized,
            phase: "error" as const,
            isError: true,
            error: { message: unavailable, retryable: false },
            defaultOpen: true,
          }
        : { ...normalized, label: safeLabel(normalized), defaultOpen: true };
  const shellState = { ...state, argsText: "", result: undefined, partialResult: undefined };
  const summary =
    unavailable !== undefined ? "Unavailable" : (correlation ?? SETTLED_SUMMARY[state.phase] ?? "");
  const cardClassName =
    unavailable === undefined
      ? "[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-raw']]:hidden"
      : "[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-status']]:hidden [&_[data-slot='u3-tool-card-raw']]:hidden";
  return (
    <div data-testid={`t7-fallback-${state.toolCallId}`} data-tool-name={state.toolName}>
      <ToolCard className={cardClassName} state={shellState} summary={summary}>
        <SafeDetails props={props} state={state} />
      </ToolCard>
    </div>
  );
};
