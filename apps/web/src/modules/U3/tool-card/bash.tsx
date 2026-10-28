import type { Omp } from "@omp-app/contracts";
import { useContext, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { BackgroundJobView } from "@/modules/R0/store/background-jobs";
import { useTranscriptDisplayPolicy } from "@/modules/U1/policy/policy";
import { TurnCancelContext } from "@/modules/U1/thread";
import { Button } from "../../../components/ui/button";
import { Icons } from "../../../tokens";
import {
  BackgroundJobCommandContext,
  BackgroundJobsContext,
  type StopOutcome,
  stopCommandFor,
  stopFailedOutcome,
  stopOutcomeOf,
} from "./background-job";
import { copyStatusText, ToolCard, type ToolCardOutcome } from "./card";
import type {
  ToolCardState,
  ToolRegistryDescriptor,
  ToolRenderer,
  ToolRendererProps,
} from "./contract";
import {
  formatBytes,
  type OutputCut,
  OutputCutNote,
  outputCutOf,
  useFullOutputFocus,
} from "./full-output";
import { normalizeToolRendererProps } from "./normalize";
import { OutputMetaSchema } from "./output-meta";
import type { CopyKind } from "./slots";
import { useStopPress } from "./stop-press";

const MAX_OUTPUT_LINES = 12;
const MAX_OUTPUT_CHARS = 8_000;

/** A command omp moved to the background. Its chip reads "In background" with the muted look of the unrecorded phase: nothing failed, and nothing more is known. */
const BACKGROUND_OUTCOME: ToolCardOutcome = { label: "In background", phase: "unrecorded" };

/**
 * The card's chip for a background command: what its stop said, else what the chat knows of its job. A job that
 * omp's process ended before its result came back reads "Ended"; a job the chat cannot place reads "In background".
 */
function backgroundChip(
  stop: StopOutcome | undefined,
  view: BackgroundJobView | undefined,
): ToolCardOutcome {
  if (stop?.status === "stopped") return { label: "Stopped", phase: "unrecorded" };
  if (stop?.status === "finished") return { label: "Finished", phase: "unrecorded" };
  if (view?.kind === "failed") return { label: "Failed", phase: "error" };
  if (view?.kind === "cancelled") return { label: "Cancelled", phase: "unrecorded" };
  if (view?.kind === "finished") return { label: "Finished", phase: "unrecorded" };
  if (view?.kind === "ended") return { label: "Ended", phase: "unrecorded" };
  return BACKGROUND_OUTCOME;
}

type BashResult = Omp.BashResult & {
  readonly stderr?: string;
  readonly wallTimeMs?: number;
  /** Set when omp moved the command to the background: the card names the job and never shows omp's text for the model. */
  readonly background?: BackgroundJob;
};

/** omp's record of a command it moved to the background (`details.async`, the record the eval card reads). */
interface BackgroundJob {
  readonly jobId: string;
  readonly state: string;
}

/** The thread's copy handler, when it gives one; otherwise the clipboard is used. */
type CopyHandler = (raw: string, kind: CopyKind) => void | Promise<void>;

export interface BashCardProps {
  readonly rendererProps: ToolRendererProps;
  readonly onCancel?: () => void | Promise<void>;
  readonly onCopy?: CopyHandler;
}

/** Renders one normalized bash tool call; stop cancels the parent turn: the one supplied, else the chat's. */
export function BashCard({ rendererProps, onCancel, onCopy }: BashCardProps) {
  const chatCancel = useContext(TurnCancelContext);
  const jobs = useContext(BackgroundJobsContext);
  const [localOutcome, setLocalOutcome] = useState<StopOutcome | undefined>(undefined);
  const normalized = normalizeToolRendererProps(rendererProps);
  const result = decodeBashResult(
    rendererProps.result ?? normalized.result ?? normalized.partialResult,
  );
  const state = bashState(normalized, result);
  const command = commandFromArgs(rendererProps.args);
  const cwd = cwdFromArgs(rendererProps.args) ?? result?.workingDir;
  const summary = singleLine(command);
  const background = result?.background;
  // With the chat's jobs, a stop is kept for the chat's page; without them (a card on its own) it is kept by this card.
  const stopOutcome = jobs === undefined ? localOutcome : jobs.outcomeOf(rendererProps.toolCallId);
  const onStopOutcome = (next: StopOutcome): void => {
    if (jobs === undefined) setLocalOutcome(next);
    else jobs.recordOutcome(rendererProps.toolCallId, next);
  };
  const view = jobs?.viewOf(rendererProps.toolCallId);
  const outcome = background === undefined ? undefined : backgroundChip(stopOutcome, view);

  return (
    <div data-slot="u3-bash-card" data-testid="u3-bash-card" title={command}>
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-raw']]:hidden"
        state={{ ...state, outputMeta: undefined, result: undefined, partialResult: undefined }}
        summary={summary}
        outcome={outcome}
      >
        <BashCommand command={command} cwd={cwd} onCopy={onCopy} />
        <BashOutput
          cut={outputCutOf(rendererProps.result)}
          result={result}
          state={state}
          onCancel={onCancel ?? chatCancel}
          onCopy={onCopy}
          stopOutcome={stopOutcome}
          onStopOutcome={onStopOutcome}
          view={view}
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

/** A failed or stopped command whose whole output is its banner sentence: the output block would only repeat it. */
function repeatsBanner(result: BashResult): boolean {
  return (
    result.exitCode === undefined &&
    result.timedOut !== true &&
    result.output.trim() === failureMessage(result)
  );
}

/**
 * The command and output are this card's facts. They sit inside its disclosure, so every call starts as one line,
 * running or finished, and a click or Enter on the line shows them.
 */
function bashState(state: ToolCardState, result: BashResult | undefined): ToolCardState {
  if (result === undefined) return state;
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
        ? undefined
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
      /**
       * `false` when the run was shorter than 1000 ms and omp added no "Wall time" footer to the text (v18.12.6
       * `packages/coding-agent/src/tools/bash.ts:726,746`); absent on results of older omp.
       */
      wallTimeNoticeEmitted: z.boolean().optional(),
      exitCode: z.number().optional(),
      timedOut: z.boolean().optional(),
      meta: z.unknown().optional(),
      // Checked by BackgroundJobSchema, not here: an unexpected shape must not hide the rest of the result.
      async: z.unknown().optional(),
    })
    .optional(),
});
const TextPartSchema = z.looseObject({ type: z.literal("text"), text: z.string() });
/** omp's `details.async` for a command moved to the background: the job's number and its state. */
const BackgroundJobSchema = z.looseObject({ jobId: z.string(), state: z.string() });

/** The result of a `!` command, the chat host's `bash` answer (omp's `BashResult`, `packages/coding-agent/src/exec/bash-executor.ts:117-135`). */
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

/** omp's wall-time notice, the first of its notices after the output; the card shows wall time apart. */
const WALL_TIME_LINE = /^Wall time: [\d.]+ seconds?$/;
/**
 * omp's other notices for the model after a command's output (omp v18.12.6 `packages/coding-agent/src/tools/bash.ts`:
 * the timeout clamp `:490-501`, the ignored `ready` `:1047`, the missing pty `:1593`, the busy session shell `:450-451`).
 * None of them is something the command printed.
 */
const OMP_NOTICE_LINES: readonly RegExp[] = [
  /^Timeout clamped to \d+s \(requested \d+s; [^)]*\)\.$/,
  /^Ignored ready: service-only, and no service name was given\.$/,
  /^pty requested but unavailable in this environment; ran without a terminal$/,
  /^Ran in a temporary shell while the session shell is busy with another command: .+$/,
];
/** omp adds "Command exited with code N" after its notices, for a failed command; the card shows the exit code apart. */
const EXIT_CODE_SUFFIX = /\n*Command exited with code -?\d+\s*$/;
/** What omp's bash tool sends the model for a command that printed nothing (v18.12.6 `tools/bash.ts:670-673`). */
const NO_OUTPUT_PLACEHOLDER = "(no output)";

/**
 * The text without omp's notice block: after the output, omp writes a blank line, then its notices one to a line, the
 * wall time first (v18.12.6 `tools/bash.ts:723-737`). The block goes only when every one of its lines is one of omp's
 * notices, and a wall-time line counts only when omp says it wrote one (`wallTime`): otherwise a last paragraph that
 * reads like one is the command's own.
 */
function withoutNoticeBlock(text: string, wallTime: boolean): string {
  const start = text.lastIndexOf("\n\n");
  if (start < 0) return text;
  const lines = text
    .slice(start + 2)
    .replace(/\n+$/, "")
    .split("\n");
  const first = lines[0] ?? "";
  const notices = wallTime && WALL_TIME_LINE.test(first) ? lines.slice(1) : lines;
  const ompNotice = (line: string) => OMP_NOTICE_LINES.some((pattern) => pattern.test(line));
  return notices.every(ompNotice) ? text.slice(0, start) : text;
}

/** Reads bash output from either the agent's bash tool or a `!` command. */
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
    exitCode: result.exitCode,
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
  const job = BackgroundJobSchema.safeParse(details.async);
  if (job.success) {
    // A command moved to the background: the text is omp's notice for the model, so the card shows the job instead.
    return {
      output: "",
      cancelled: false,
      truncated: false,
      totalLines: 0,
      totalBytes: 0,
      outputLines: 0,
      outputBytes: 0,
      exitCode: undefined,
      background: { jobId: job.data.jobId, state: job.data.state },
      ...(details.wallTimeMs === undefined ? {} : { wallTimeMs: Math.round(details.wallTimeMs) }),
    };
  }
  // omp writes its notes after the output: the wall time (only for a run of a second or more) and its other notices
  // (a missing pty, a clamped timeout…), then the exit code of a failed command. The card shows wall time and exit code
  // as facts of its own (the meta row and the banner), and the notices are for the model, so none of them is part of
  // what the command printed. With `wallTimeNoticeEmitted: false` there is no wall-time line: a last line that reads
  // like one is the command's own (omp's renderer strips it only when the flag is not false,
  // `packages/tui/src/tools/bash.ts:328-330`).
  const withoutExitCode =
    details.exitCode === undefined || details.exitCode === 0
      ? text
      : text.replace(EXIT_CODE_SUFFIX, "");
  const wallTime = details.wallTimeMs !== undefined && details.wallTimeNoticeEmitted !== false;
  const printed = withoutNoticeBlock(withoutExitCode, wallTime).replace(/\n+$/, "");
  const output = printed === NO_OUTPUT_PLACEHOLDER ? "" : printed;
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
    exitCode: details.exitCode,
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
  stopOutcome,
  onStopOutcome,
  view,
}: {
  readonly result: BashResult | undefined;
  readonly state: ToolCardState;
  readonly cut?: OutputCut;
  readonly onCancel?: () => void | Promise<void>;
  readonly onCopy?: CopyHandler;
  readonly stopOutcome: StopOutcome | undefined;
  readonly onStopOutcome: (outcome: StopOutcome) => void;
  readonly view: BackgroundJobView | undefined;
}) {
  const policy = useTranscriptDisplayPolicy();
  const [expanded, setExpanded] = useState(false);
  const outputExpanded = expanded || policy.expandTools;
  // A change of the transcript's expand-all flag expands or collapses this output's own choice too.
  const [seenExpandTools, setSeenExpandTools] = useState(policy.expandTools);
  if (seenExpandTools !== policy.expandTools) {
    setSeenExpandTools(policy.expandTools);
    setExpanded(false);
  }
  const outputRef = useRef<HTMLDivElement>(null);
  const full = useFullOutputFocus(cut, outputRef, "[data-u3-show-all]");
  if (result === undefined) {
    // Output can still arrive only while the command runs; a stopped or failed command says what it has.
    const commandRunning = state.phase === "running" || state.phase === "partial";
    return (
      <>
        <div className="text-muted-foreground px-3 py-2 text-xs" data-slot="u3-bash-empty">
          {commandRunning ? "No output yet." : "No output was recorded."}
        </div>
        {commandRunning && onCancel !== undefined && (
          <div className="px-3 pb-2">
            <StopTurnButton onCancel={onCancel} />
          </div>
        )}
      </>
    );
  }
  if (result.background !== undefined)
    return (
      <BackgroundNote
        job={result.background}
        onOutcome={onStopOutcome}
        outcome={stopOutcome}
        view={view}
      />
    );
  if ((state.phase === "error" || state.phase === "cancelled") && repeatsBanner(result))
    return null;
  const preview = previewOutput(result.output);
  const output = outputExpanded ? result.output : preview.text;
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
    <div className="flex min-w-0 flex-col gap-2 py-2" data-slot="u3-bash-output" ref={outputRef}>
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
          {previewControls && !outputExpanded && <span>{shownNote}</span>}
          {previewControls && !policy.expandTools && (
            <Button
              className="w-fit"
              data-u3-show-all
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
          {full.loaded && (
            <span role="status" aria-live="polite">
              Full output loaded
            </span>
          )}
        </div>
      )}
      {cut !== undefined && (
        <OutputCutNote
          cut={cut}
          lead={partialOutputNote(cut, outputExpanded ? { ...preview, cut: false } : preview)}
          onLoaded={full.onLoaded}
          toolCallId={state.toolCallId}
        />
      )}
      {onCancel !== undefined && (state.phase === "running" || state.phase === "partial") && (
        <StopTurnButton onCancel={onCancel} />
      )}
    </div>
  );
}

/**
 * omp moved the command to the background: the card names the job and shows none of omp's words for the model. Only a
 * job the chat knows to be running offers a Stop, and that Stop is for this job alone.
 */
function BackgroundNote({
  job,
  view,
  outcome,
  onOutcome,
}: {
  readonly job: BackgroundJob;
  readonly view: BackgroundJobView | undefined;
  readonly outcome: StopOutcome | undefined;
  readonly onOutcome: (outcome: StopOutcome) => void;
}) {
  const runCommand = useContext(BackgroundJobCommandContext);
  const [pending, setPending] = useState(false);
  const command = runCommand === undefined ? undefined : stopCommandFor(job.jobId);
  const stopped = outcome?.status === "stopped" || outcome?.status === "finished";
  const running = view?.kind === "running" && !stopped;
  async function stop(): Promise<void> {
    if (runCommand === undefined || command === undefined) return;
    setPending(true);
    try {
      onOutcome(stopOutcomeOf(await runCommand(command), job.jobId));
    } catch (error) {
      onOutcome(
        stopFailedOutcome(job.jobId, error instanceof Error ? error.message : String(error)),
      );
    } finally {
      setPending(false);
    }
  }
  const press = useStopPress(() => void stop(), pending);
  return (
    <div
      className="text-muted-foreground flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
      data-slot="u3-bash-background"
      {...press.container}
    >
      <p>{backgroundNoteOf(job.jobId, view, running)}</p>
      {running && command !== undefined && (
        <Button
          aria-label={`Stop background job ${job.jobId}`}
          disabled={pending}
          ref={press.control}
          size="sm"
          type="button"
          variant="outline"
        >
          Stop
        </Button>
      )}
      {outcome !== undefined && <p role="status">{outcome.sentence}</p>}
    </div>
  );
}

/**
 * What the card says of its job, from what the chat knows of it. A job the chat cannot place is not said to run, and
 * a job whose omp process ended before its result came back is said to have ended.
 */
function backgroundNoteOf(
  jobId: string,
  view: BackgroundJobView | undefined,
  running: boolean,
): string {
  if (running) return "Running in the background.";
  if (view?.kind === "failed") return `Background job ${jobId} failed.`;
  if (view?.kind === "cancelled") return `Background job ${jobId} cancelled.`;
  if (view?.kind === "finished") return `Background job ${jobId} finished.`;
  if (view?.kind === "ended") return "The background command stopped before its result came back.";
  return `Background job ${jobId}.`;
}

/** The turn's stop, offered while the command runs: it stops the chat's turn, as the composer's stop does. */
function StopTurnButton({ onCancel }: { readonly onCancel: () => void | Promise<void> }) {
  return (
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

/** omp's own word that it shortened the output: `details.meta.truncation`, or a `!` command's `truncated`. */
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
