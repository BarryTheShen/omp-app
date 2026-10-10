import type { OmpWire } from "@omp-app/contracts";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "../../../components/ui/button";
import { Icons } from "../../../tokens";
import { copyStatusText, ToolCard } from "./card";
import type {
  ToolCardState,
  ToolRegistryDescriptor,
  ToolRenderer,
  ToolRendererProps,
} from "./contract";
import { formatBytes, type OutputCut, OutputCutNote, outputCutOf } from "./full-output";
import { normalizeToolRendererProps } from "./normalize";
import { OutputMetaSchema } from "./output-meta";
import type { CopyKind } from "./slots";

const MAX_OUTPUT_LINES = 12;
const MAX_OUTPUT_CHARS = 8_000;

type BashResult = OmpWire.BashResult & {
  readonly stderr?: string;
  readonly wallTimeMs?: number;
};

/** The thread's copy handler, when it gives one; otherwise the clipboard is used. */
type CopyHandler = (raw: string, kind: CopyKind) => void | Promise<void>;

export interface BashCardProps {
  readonly rendererProps: ToolRendererProps;
  readonly onCancel?: () => void | Promise<void>;
  readonly onCopy?: CopyHandler;
}

/** Renders one normalized bash tool call; stop cancels the parent turn when supplied. */
export function BashCard({ rendererProps, onCancel, onCopy }: BashCardProps) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const result = decodeBashResult(
    rendererProps.result ?? normalized.result ?? normalized.partialResult,
  );
  const state = bashState(normalized, result);
  const command = commandFromArgs(rendererProps.args);
  const cwd = cwdFromArgs(rendererProps.args) ?? result?.workingDir;
  const summary = singleLine(command);

  return (
    <div data-slot="u3-bash-card" data-testid="u3-bash-card" title={command}>
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-raw']]:hidden"
        state={{ ...state, outputMeta: undefined, result: undefined, partialResult: undefined }}
        summary={summary}
      >
        <BashCommand command={command} cwd={cwd} onCopy={onCopy} />
        <BashOutput
          cut={outputCutOf(rendererProps.result)}
          result={result}
          state={state}
          onCancel={onCancel}
          onCopy={onCopy}
        />
      </ToolCard>
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

/**
 * omp's own reason for a failed command: a timeout, its exit code, or else the reason it wrote last
 * (`[Command aborted]`, `Command failed: …`), or the first line it printed (omp sends no exit code
 * for a command that never ran, such as one whose directory is missing).
 */
export function failureMessage(result: BashResult): string {
  if (result.timedOut === true) return "Command timed out.";
  if (result.exitCode !== undefined) return `Command exited with code ${result.exitCode}.`;
  const lines = ansiTokens(result.output)
    .map((token) => token.text)
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const reason =
    lines.findLast((line) => line.startsWith("[Command ") || line.startsWith("Command failed")) ??
    lines[0];
  if (reason === undefined) return "Command failed without printing a reason.";
  return reason.length > 160 ? `${reason.slice(0, 157)}…` : reason;
}

/** A failure whose whole output is its banner sentence: the output block would only repeat it. */
function repeatsBanner(result: BashResult): boolean {
  return (
    result.exitCode === undefined &&
    result.timedOut !== true &&
    result.output.trim() === failureMessage(result)
  );
}

/**
 * The command and output are this card's facts, so it opens at first sight in every phase; a person
 * can fold it from its header.
 */
function bashState(state: ToolCardState, result: BashResult | undefined): ToolCardState {
  if (result === undefined) return { ...state, defaultOpen: true };
  const phase = result.cancelled
    ? "cancelled"
    : result.timedOut || (result.exitCode !== undefined && result.exitCode !== 0)
      ? "error"
      : state.phase;
  const error =
    phase === "error"
      ? {
          code: "timeout" as const,
          message: failureMessage(result),
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
    defaultOpen: true,
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
      meta: z.unknown().optional(),
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
export function decodeBashResult(value: unknown): BashResult | undefined {
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
  // omp records a cut in `details.meta.truncation`, and only when it cut the output.
  const meta = OutputMetaSchema.safeParse(details.meta);
  const truncation = meta.success ? meta.data.truncation : undefined;
  return {
    output,
    cancelled: false,
    truncated: truncation !== undefined && truncation.truncated !== false,
    totalLines: truncation?.totalLines ?? lines,
    totalBytes: truncation?.totalBytes ?? output.length,
    outputLines: truncation?.outputLines ?? lines,
    outputBytes: truncation?.outputBytes ?? output.length,
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

function cwdFromArgs(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args) || !("cwd" in args)) {
    return undefined;
  }
  return typeof args.cwd === "string" ? args.cwd : undefined;
}

/** How long a copy's confirmation stays on screen before it clears. */
const COPY_NOTE_MS = 1_500;

/** Runs a copy and says in words what happened: the confirmation, or that the clipboard refused. */
function useCopyStatus(): {
  readonly status: string | undefined;
  readonly copy: (write: () => void | Promise<void>, copied: string) => Promise<void>;
} {
  const [status, setStatus] = useState<string | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);
  const show = (text: string) => {
    if (!mounted.current) return;
    window.clearTimeout(timer.current);
    setStatus(text);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      setStatus(undefined);
    }, COPY_NOTE_MS);
  };
  const copy = async (write: () => void | Promise<void>, copied: string) => {
    try {
      await write();
      show(copied);
    } catch {
      show(copyStatusText("failed"));
    }
  };
  return { status, copy };
}

/** The thread's copy handler when it gives one; otherwise the clipboard. */
function writeCopy(
  text: string,
  kind: CopyKind,
  onCopy: CopyHandler | undefined,
): void | Promise<void> {
  return onCopy !== undefined ? onCopy(text, kind) : navigator.clipboard.writeText(text);
}

function BashCommand({
  command,
  cwd,
  onCopy,
}: {
  readonly command: string;
  readonly cwd?: string;
  readonly onCopy?: CopyHandler;
}) {
  const { status, copy } = useCopyStatus();
  return (
    <section className="flex min-w-0 flex-col gap-2 py-2" data-slot="u3-bash-command">
      <div className="flex items-start gap-2">
        <pre className="border-border bg-muted/40 min-w-0 flex-1 overflow-auto rounded-lg border p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
          $ {command}
        </pre>
        <Button
          aria-label="Copy bash command"
          size="icon-xs"
          type="button"
          variant="ghost"
          onClick={() => void copy(() => writeCopy(command, "code", onCopy), "Copied command")}
        >
          <Icons.copy aria-hidden="true" />
        </Button>
      </div>
      {status !== undefined && (
        <span aria-live="polite" className="text-xs text-muted-foreground" role="status">
          {status}
        </span>
      )}
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
  cut,
  result,
  state,
  onCancel,
  onCopy,
}: {
  readonly result: BashResult | undefined;
  readonly state: ToolCardState;
  readonly cut?: OutputCut;
  readonly onCancel?: () => void | Promise<void>;
  readonly onCopy?: CopyHandler;
}) {
  const [expanded, setExpanded] = useState(false);
  if (result === undefined) {
    return (
      <div className="text-muted-foreground px-3 py-2 text-xs" data-slot="u3-bash-empty">
        Waiting for bash output…
      </div>
    );
  }
  if (state.phase === "error" && repeatsBanner(result)) return null;
  const preview = previewOutput(result.output);
  const output = expanded ? result.output : preview.text;
  const shortened = shortenedNote(result);
  // While the app holds part of the output, the note below says so once and "Load full output" is the next
  // step. A "Show all" here would show only the loaded lines, so the preview controls wait for the full text.
  const previewControls = preview.cut && cut === undefined;
  const shownNote = `Showing the first ${count(preview.shown)} of ${count(preview.total)} ${preview.unit}.`;
  const copiedOutput =
    cut !== undefined
      ? copyStatusText("copiedShown")
      : result.truncated
        ? "Copied the shown part of the output."
        : copyStatusText("copied");
  const stderr = result.stderr?.trim() ?? "";
  return (
    <div className="flex min-w-0 flex-col gap-2 py-2" data-slot="u3-bash-output">
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
        <OutputBlock
          label="stdout"
          text={output}
          stderr={false}
          raw={result.output}
          copyLabel="Copy raw output"
          copied={copiedOutput}
          onCopy={onCopy}
        />
      )}
      {stderr.length > 0 && (
        <OutputBlock
          label="stderr"
          text={stderr}
          stderr
          raw={stderr}
          copyLabel="Copy raw stderr"
          copied="Copied raw stderr"
          onCopy={onCopy}
        />
      )}
      {(shortened !== undefined || previewControls) && (
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          data-slot="u3-bash-shown"
        >
          {shortened !== undefined && <span>{shortened}</span>}
          {previewControls && !expanded && <span>{shownNote}</span>}
          {previewControls && (
            <Button
              className="w-fit"
              size="xs"
              type="button"
              variant="outline"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded
                ? `Show fewer ${preview.unit}`
                : `Show all ${count(preview.total)} ${preview.unit}`}
            </Button>
          )}
        </div>
      )}
      {cut !== undefined && (
        <OutputCutNote
          cut={cut}
          lead={partialOutputNote(cut, preview)}
          toolCallId={state.toolCallId}
        />
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
  raw,
  copyLabel,
  copied,
  onCopy,
}: {
  readonly label: string;
  readonly text: string;
  readonly stderr: boolean;
  /** The whole output: the copy control copies all of it, not only the lines the card shows. */
  readonly raw: string;
  readonly copyLabel: string;
  /** The confirmation once the copy has worked. */
  readonly copied: string;
  readonly onCopy?: CopyHandler;
}) {
  const { status, copy } = useCopyStatus();
  return (
    <section data-slot={`u3-bash-${label}`} data-testid={`u3-bash-${label}`}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <div className="flex items-center gap-2">
          {status !== undefined && (
            <span aria-live="polite" className="text-xs text-muted-foreground" role="status">
              {status}
            </span>
          )}
          <Button
            aria-label={copyLabel}
            className="text-muted-foreground"
            size="icon-xs"
            type="button"
            variant="ghost"
            onClick={() => void copy(() => writeCopy(raw, "result", onCopy), copied)}
          >
            <Icons.copy aria-hidden="true" />
          </Button>
        </div>
      </div>
      <pre className="border-border bg-muted/40 max-h-80 overflow-auto rounded-lg border p-3 text-xs leading-relaxed whitespace-pre-wrap">
        {ansiTokens(text).map((token) => (
          <span className={stderr ? "text-danger" : token.className} key={token.start}>
            {token.text}
          </span>
        ))}
      </pre>
    </section>
  );
}

type AnsiToken = { readonly text: string; readonly className?: string; readonly start: number };

function ansiTokens(text: string): readonly AnsiToken[] {
  const tokens: AnsiToken[] = [];
  const pattern = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)m`, "g");
  let start = 0;
  let className: string | undefined;
  while (true) {
    const match = pattern.exec(text);
    if (match === null) break;
    if (match.index > start) {
      tokens.push({ text: text.slice(start, match.index), className, start });
    }
    className = ansiClass(match[1] ?? "");
    start = match.index + match[0].length;
  }
  if (start < text.length) tokens.push({ text: text.slice(start), className, start });
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

/** What the card shows of an output: its first lines, and at most MAX_OUTPUT_CHARS characters. */
interface OutputPreview {
  readonly text: string;
  readonly cut: boolean;
  /** What the cut is counted in: lines, or characters when one line is too long to show. */
  readonly unit: "lines" | "characters";
  readonly shown: number;
  readonly total: number;
}

function previewOutput(value: string): OutputPreview {
  const lines = value.split("\n");
  const firstLines = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
  if (firstLines.length > MAX_OUTPUT_CHARS) {
    const text = firstLines.slice(0, MAX_OUTPUT_CHARS);
    return { text, cut: true, unit: "characters", shown: text.length, total: value.length };
  }
  if (lines.length > MAX_OUTPUT_LINES) {
    return {
      text: firstLines,
      cut: true,
      unit: "lines",
      shown: MAX_OUTPUT_LINES,
      total: lines.length,
    };
  }
  return { text: value, cut: false, unit: "lines", shown: lines.length, total: lines.length };
}

/** omp's own word that it shortened the output: `details.meta.truncation`, or the RPC `truncated`. */
function shortenedNote(result: BashResult): string | undefined {
  if (!result.truncated) return undefined;
  if (result.totalLines > result.outputLines) {
    return `omp shortened this output: showing ${count(result.outputLines)} of ${count(result.totalLines)} lines.`;
  }
  if (result.totalBytes > result.outputBytes) {
    return `omp shortened this output: showing ${count(result.outputBytes)} of ${count(result.totalBytes)} bytes.`;
  }
  return "omp shortened this output.";
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function unitName(amount: number, unit: OutputPreview["unit"]): string {
  if (unit === "lines") return amount === 1 ? "line" : "lines";
  return amount === 1 ? "character" : "characters";
}

/**
 * The one note for an output the app holds only in part: what the card shows of the loaded text, and
 * how much of the whole output the app holds. The thread's full output is the next step.
 */
function partialOutputNote(cut: OutputCut, preview: OutputPreview): string {
  const held = `the app has loaded ${formatBytes(cut.shownBytes)} of ${formatBytes(cut.totalBytes)}`;
  return preview.cut
    ? `Showing the first ${count(preview.shown)} ${unitName(preview.shown, preview.unit)} of the ${count(preview.total)} loaded; ${held}.`
    : `Showing the ${count(preview.total)} loaded ${unitName(preview.total, preview.unit)}; ${held}.`;
}
