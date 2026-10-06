import type { OmpWire } from "@omp-app/contracts";
import { useState } from "react";
import { z } from "zod";
import { Button } from "../../../components/ui/button";
import { Icons } from "../../../tokens";
import { ToolCard } from "./card";
import type {
  OutputMeta,
  ToolCardState,
  ToolRegistryDescriptor,
  ToolRenderer,
  ToolRendererProps,
} from "./contract";
import { normalizeToolRendererProps } from "./normalize";

const MAX_OUTPUT_LINES = 12;
const MAX_OUTPUT_CHARS = 8_000;

type BashResult = OmpWire.BashResult & {
  readonly stderr?: string;
  readonly wallTimeMs?: number;
};

export interface BashCardProps {
  readonly rendererProps: ToolRendererProps;
  readonly onCancel?: () => void | Promise<void>;
  readonly onCopy?: (raw: string, kind: "code") => void | Promise<void>;
}

/** Renders one normalized bash tool call; stop cancels the parent turn when supplied. */
export function BashCard({ rendererProps, onCancel, onCopy }: BashCardProps) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const result = decodeBashResult(
    rendererProps.result ?? normalized.result ?? normalized.partialResult,
  );
  const outputMeta = bashOutputMeta(result, normalized.outputMeta);
  const state = bashState(normalized, result, outputMeta);
  const command = commandFromArgs(rendererProps.args);
  const cwd = cwdFromArgs(rendererProps.args) ?? result?.workingDir;
  const summary = singleLine(command);

  return (
    <div data-slot="u3-bash-card" data-testid="u3-bash-card" title={command}>
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden"
        state={{ ...state, result: undefined, partialResult: undefined, outputMeta }}
        summary={summary}
      />
      <BashCommand command={command} cwd={cwd} onCopy={onCopy} />
      <BashOutput result={result} state={state} onCancel={onCancel} />
    </div>
  );
}

/** Assistant-ui backend renderer entry used by U3's descriptor composition. */
export const BashToolRenderer: ToolRenderer = (props) => <BashCard rendererProps={props} />;

export const U3_BASH_DESCRIPTOR = {
  kind: "tool",
  id: "U3.bash",
  owner: "U3",
  title: "Bash",
  covers: ["E1.bash"],
  requires: [],
  match: { by: "name", name: "bash" },
  renderer: BashToolRenderer,
} as const satisfies ToolRegistryDescriptor;

function bashState(
  state: ToolCardState,
  result: BashResult | undefined,
  outputMeta: OutputMeta | undefined,
): ToolCardState {
  if (result === undefined) return { ...state, outputMeta };
  const phase = result.cancelled
    ? "cancelled"
    : result.timedOut || (result.exitCode !== undefined && result.exitCode !== 0)
      ? "error"
      : state.phase;
  const error =
    phase === "error"
      ? {
          code: "timeout" as const,
          message:
            result.timedOut === true
              ? "Command timed out."
              : `Command exited with code ${result.exitCode ?? "unknown"}.`,
          retryable: false,
          timeout: result.timedOut === true,
        }
      : phase === "cancelled"
        ? { code: "cancelled" as const, message: "Command cancelled.", retryable: false }
        : state.error;
  return {
    ...state,
    phase,
    result: undefined,
    partialResult: undefined,
    isError: phase === "error",
    cancelled: phase === "cancelled",
    timedOut: result.timedOut === true,
    error,
    outputMeta,
    defaultOpen: phase !== "success",
  };
}

/**
 * The bash *tool* result omp emits for an agent's call, also each `tool_execution_update`
 * partialResult: the AgentToolResult of omp v18.6.1 `packages/coding-agent/src/tools/bash.ts`, with
 * `BashToolDetails` (`packages/tui/src/tools/bash.ts:54-105`).
 */
const BashToolResultSchema = z.looseObject({
  content: z.array(z.unknown()),
  details: z
    .looseObject({
      wallTimeMs: z.number().optional(),
      exitCode: z.number().optional(),
      timedOut: z.boolean().optional(),
    })
    .optional(),
});
const TextPartSchema = z.looseObject({ type: z.literal("text"), text: z.string() });

/** The RPC `bash` command's result (`packages/coding-agent/src/exec/bash-executor.ts:87-102`). */
const BashCommandResultSchema = z.looseObject({
  output: z.string(),
  exitCode: z.number().optional(),
  cancelled: z.boolean().optional(),
  timedOut: z.boolean().optional(),
  truncated: z.boolean().optional(),
  totalLines: z.number().optional(),
  totalBytes: z.number().optional(),
  outputLines: z.number().optional(),
  outputBytes: z.number().optional(),
  artifactId: z.string().optional(),
  artifactElidedBytes: z.number().optional(),
  workingDir: z.string().optional(),
  wallTimeMs: z.number().optional(),
  stderr: z.string().optional(),
});

/** omp appends "Wall time: N seconds" to the text it sends the model; the card shows wall time apart. */
const WALL_TIME_SUFFIX = /\n*Wall time: [\d.]+ seconds?\s*$/;

/** Reads bash output from either the agent's bash tool or the RPC bash command. */
function decodeBashResult(value: unknown): BashResult | undefined {
  const tool = BashToolResultSchema.safeParse(value);
  if (tool.success) return decodeBashToolResult(tool.data);
  const command = BashCommandResultSchema.safeParse(value);
  if (!command.success) return undefined;
  const result = command.data;
  const lines = result.output.split("\n").length;
  return {
    output: result.output,
    cancelled: result.cancelled === true,
    truncated: result.truncated === true,
    totalLines: result.totalLines ?? lines,
    totalBytes: result.totalBytes ?? result.output.length,
    outputLines: result.outputLines ?? lines,
    outputBytes: result.outputBytes ?? result.output.length,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.timedOut === true ? { timedOut: true } : {}),
    ...(result.artifactId === undefined ? {} : { artifactId: result.artifactId }),
    ...(result.artifactElidedBytes === undefined
      ? {}
      : { artifactElidedBytes: result.artifactElidedBytes }),
    ...(result.workingDir === undefined ? {} : { workingDir: result.workingDir }),
    ...(result.wallTimeMs === undefined ? {} : { wallTimeMs: result.wallTimeMs }),
    ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
  };
}

function decodeBashToolResult(result: z.infer<typeof BashToolResultSchema>): BashResult {
  const text = result.content
    .map((part) => {
      const textPart = TextPartSchema.safeParse(part);
      return textPart.success ? textPart.data.text : "";
    })
    .join("");
  const details = result.details ?? {};
  const withoutWallTime =
    details.wallTimeMs === undefined ? text : text.replace(WALL_TIME_SUFFIX, "");
  const output = withoutWallTime.replace(/\n+$/, "");
  const lines = output.length === 0 ? 0 : output.split("\n").length;
  return {
    output,
    cancelled: false,
    truncated: false,
    totalLines: lines,
    totalBytes: output.length,
    outputLines: lines,
    outputBytes: output.length,
    ...(details.exitCode === undefined ? {} : { exitCode: details.exitCode }),
    ...(details.timedOut === true ? { timedOut: true } : {}),
    ...(details.wallTimeMs === undefined ? {} : { wallTimeMs: Math.round(details.wallTimeMs) }),
  };
}

function commandFromArgs(args: unknown): string {
  if (args !== null && typeof args === "object" && !Array.isArray(args) && "command" in args) {
    const command = args.command;
    return typeof command === "string" ? command : "bash";
  }
  return "bash";
}

function singleLine(command: string): string {
  const oneLine = command.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}…` : oneLine;
}

function bashOutputMeta(
  result: BashResult | undefined,
  existing: OutputMeta | undefined,
): OutputMeta | undefined {
  if (result === undefined || !result.truncated) return existing;
  return {
    ...existing,
    truncation: {
      direction: "tail",
      reason: "lines",
      totalLines: result.totalLines,
      shownLines: result.outputLines,
      totalBytes: result.totalBytes,
      shownBytes: result.outputBytes,
      omittedLines: Math.max(0, result.totalLines - result.outputLines),
      omittedBytes: Math.max(0, result.totalBytes - result.outputBytes),
      artifactId: result.artifactId,
      artifactElidedBytes: result.artifactElidedBytes,
    },
  };
}
function cwdFromArgs(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args) || !("cwd" in args)) {
    return undefined;
  }
  return typeof args.cwd === "string" ? args.cwd : undefined;
}

function BashCommand({
  command,
  cwd,
  onCopy,
}: {
  readonly command: string;
  readonly cwd?: string;
  readonly onCopy?: (raw: string, kind: "code") => void | Promise<void>;
}) {
  const copy = async () => {
    if (onCopy !== undefined) {
      await onCopy(command, "code");
    } else if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(command);
    }
  };
  return (
    <section
      className="ms-2 flex min-w-0 flex-col gap-2 border-s-2 border-border/70 py-2 ps-4"
      data-slot="u3-bash-command"
    >
      <div className="flex items-start gap-2">
        <pre className="border-border bg-muted/40 min-w-0 flex-1 overflow-auto rounded-lg border p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
          $ {command}
        </pre>
        <Button
          aria-label="Copy bash command"
          size="icon-xs"
          type="button"
          variant="ghost"
          onClick={() => void copy()}
        >
          <Icons.copy aria-hidden="true" />
        </Button>
      </div>
      {cwd !== undefined && (
        <span
          className="w-fit rounded border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground"
          data-slot="u3-bash-cwd"
        >
          CWD: {cwd}
        </span>
      )}
    </section>
  );
}

function BashOutput({
  result,
  state,
  onCancel,
}: {
  readonly result: BashResult | undefined;
  readonly state: ToolCardState;
  readonly onCancel?: () => void | Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (result === undefined) {
    return (
      <div className="text-muted-foreground px-3 py-2 text-xs" data-slot="u3-bash-empty">
        Waiting for bash output…
      </div>
    );
  }
  const output = expanded ? result.output : previewOutput(result.output);
  const stderr = result.stderr?.trim() ?? "";
  return (
    <div
      className="ms-2 flex min-w-0 flex-col gap-2 border-s-2 border-border/70 py-2 ps-4"
      data-slot="u3-bash-output"
    >
      <div
        className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
        data-slot="u3-bash-meta"
      >
        {result.exitCode !== undefined && (
          <span className="rounded border border-border px-2 py-0.5">
            Exit code: {result.exitCode}
          </span>
        )}
        {result.timedOut && (
          <span className="rounded border border-warning/40 bg-warning-surface px-2 py-0.5">
            Timed out
          </span>
        )}
        {state.phase === "cancelled" && (
          <span className="rounded border border-border px-2 py-0.5">Cancelled</span>
        )}
        {result.wallTimeMs !== undefined && <span>Wall time: {result.wallTimeMs}ms</span>}
      </div>
      {result.output.length === 0 ? (
        <p className="text-muted-foreground text-xs" data-slot="u3-bash-no-output">
          No output
        </p>
      ) : (
        <OutputBlock label="stdout" text={output} stderr={false} />
      )}
      {stderr.length > 0 && <OutputBlock label="stderr" text={stderr} stderr />}
      {result.truncated && !expanded && (
        <Button
          className="w-fit self-start"
          size="xs"
          type="button"
          variant="outline"
          onClick={() => setExpanded(true)}
        >
          Show more
        </Button>
      )}
      {onCancel !== undefined && (state.phase === "running" || state.phase === "partial") && (
        <Button
          aria-label="Stop turn"
          size="sm"
          type="button"
          variant="outline"
          onClick={() => void onCancel()}
        >
          <Icons.stop aria-hidden="true" />
          Stop turn
        </Button>
      )}
    </div>
  );
}

function OutputBlock({
  label,
  text,
  stderr,
}: {
  readonly label: string;
  readonly text: string;
  readonly stderr: boolean;
}) {
  return (
    <section data-slot={`u3-bash-${label}`} data-testid={`u3-bash-${label}`}>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="border-border bg-muted/40 max-h-80 overflow-auto rounded-lg border p-3 text-xs leading-relaxed whitespace-pre-wrap">
        {ansiTokens(text).map((token) => (
          <span
            className={stderr ? "text-danger" : token.className}
            key={`${token.className ?? ""}:${token.text}`}
          >
            {token.text}
          </span>
        ))}
      </pre>
    </section>
  );
}

type AnsiToken = { readonly text: string; readonly className?: string };

function ansiTokens(text: string): readonly AnsiToken[] {
  const tokens: AnsiToken[] = [];
  const pattern = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)m`, "g");
  let start = 0;
  let className: string | undefined;
  while (true) {
    const match = pattern.exec(text);
    if (match === null) break;
    if (match.index > start) tokens.push({ text: text.slice(start, match.index), className });
    className = ansiClass(match[1] ?? "");
    start = match.index + match[0].length;
  }
  if (start < text.length) tokens.push({ text: text.slice(start), className });
  return tokens;
}

function ansiClass(codes: string): string | undefined {
  const values = codes.length === 0 ? [0] : codes.split(";").map(Number);
  if (values.includes(0)) return undefined;
  const classes: string[] = [];
  for (const code of values) {
    if (code === 1) classes.push("font-semibold");
    if (code === 2) classes.push("text-muted-foreground");
    if (code === 30) classes.push("text-foreground");
    if (code === 31) classes.push("text-danger");
    if (code === 32) classes.push("text-success");
    if (code === 33) classes.push("text-warning");
    if (code === 34) classes.push("text-info");
    if (code === 35) classes.push("text-primary");
    if (code === 36) classes.push("text-info");
    if (code === 37) classes.push("text-foreground");
  }
  return classes.length > 0 ? classes.join(" ") : undefined;
}

function previewOutput(value: string): string {
  const lines = value.split("\n");
  if (lines.length <= MAX_OUTPUT_LINES && value.length <= MAX_OUTPUT_CHARS) return value;
  const preview = lines.slice(0, MAX_OUTPUT_LINES).join("\n").slice(0, MAX_OUTPUT_CHARS);
  return `${preview}${preview.length < value.length ? "\n…" : ""}`;
}
