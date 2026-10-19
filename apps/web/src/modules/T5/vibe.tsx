import type { ReactNode } from "react";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolCardState, ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { detailsSource, splitToolResult } from "../U3/tool-card/result";
import { TextOutput } from "../U3/tool-card/text-output";
import { countOf, malformedState, RawDetails, StatusChip } from "./coordination";
import {
  decodeVibeDetails,
  type VibeDetails,
  VibeKillArgsSchema,
  type VibeScreen,
  VibeSendArgsSchema,
} from "./models";

/*
 * The cards for send, list, wait and kill; the spawn card is `vibe-spawn.tsx`. Each card shows what omp returned.
 * None sends a message, waits, kills or steers a worker, and none reads `history://`. omp v18.8.9 builds these results
 * in `packages/coding-agent/src/tools/vibe.ts` (send 107-129, wait 133-208, kill 210-234, list 236-272) and types them
 * in `packages/tui/src/tools/vibe.ts`.
 */

type VibeWait = NonNullable<VibeDetails["wait"]>;
type VibeSend = NonNullable<VibeDetails["send"]>;
type VibeKill = NonNullable<VibeDetails["killed"]>;

const CLI_LABEL: Record<VibeScreen["cli"], string> = { fast: "fast worker", good: "good worker" };
const DELIVERY_LABEL: Record<VibeSend["mode"], string> = {
  turn: "A new turn",
  steered: "Steered into the running turn",
  queued: "Queued after the running turn",
};

const MAX_TRACE_LINES = 4;
const MAX_OUTPUT_LINES = 6;
const CARD_CLASSES =
  "[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-result']]:hidden [&_[data-slot='u3-tool-card-raw']]:hidden";

/** One call: its normalized state, omp's decoded details (undefined when omp sent none), and omp's own text. */
interface VibeCall {
  readonly state: ToolCardState;
  readonly details: VibeDetails | undefined;
  readonly text: string;
}

function readVibeCall(props: ToolRendererProps): VibeCall {
  const normalized = normalizeToolRendererProps(props);
  const raw = props.result ?? normalized.result ?? normalized.partialResult;
  const text = raw === undefined ? "" : splitToolResult(raw).text;
  const decoded = raw === undefined ? undefined : decodeVibeDetails(detailsSource(raw));
  if (decoded?.ok === false) {
    return {
      state: malformedState(normalized, decoded.error.appError.message),
      details: undefined,
      text,
    };
  }
  return { state: normalized, details: decoded?.ok === true ? decoded.value : undefined, text };
}

function VibeCard({
  call,
  summary,
  testId,
  children,
}: {
  readonly call: VibeCall;
  readonly summary: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="min-w-0"
      data-slot={`t5-vibe-${testId}-card`}
      data-testid={`t5-vibe-${testId}-card`}
    >
      <ToolCard
        className={CARD_CLASSES}
        state={{ ...call.state, result: undefined, partialResult: undefined }}
        summary={summary}
      >
        <RawDetails state={call.state} />
        {children}
      </ToolCard>
    </div>
  );
}

/** omp's own words show when the call has them and did not fail: a failed call shows its error line instead. */
function ompTextShown(call: VibeCall): boolean {
  return !call.state.isError && call.text.trim() !== "";
}

/** omp's own words for the call, when they are shown at all. */
function OmpText({ call, testId }: { readonly call: VibeCall; readonly testId: string }) {
  if (!ompTextShown(call)) return null;
  return <TextOutput testId={testId} text={call.text} />;
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <p className="flex min-w-0 flex-wrap gap-x-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all font-mono">{value}</span>
    </p>
  );
}

/** The last lines of a worker's trace or streamed text, with how many earlier lines the card leaves out. */
function TailLines({
  label,
  lines,
  max,
}: {
  readonly label: string;
  readonly lines: readonly string[];
  readonly max: number;
}) {
  if (lines.length === 0) return null;
  const shown = lines.slice(-max);
  const earlier = lines.length - shown.length;
  return (
    <div className="min-w-0 text-xs">
      <p className="text-muted-foreground">
        {label}
        {earlier > 0 ? ` (last ${shown.length} of ${lines.length})` : ""}
      </p>
      <p className="whitespace-pre-wrap break-words font-mono">{shown.join("\n")}</p>
    </div>
  );
}

/** One worker's screen: its state, what it is doing now, and the tail of its trace and streamed text. */
function ScreenRow({ screen }: { readonly screen: VibeScreen }) {
  return (
    <li
      className="flex min-w-0 flex-col gap-1"
      data-slot="t5-vibe-screen"
      data-state={screen.state}
      data-testid={`t5-vibe-screen-${screen.id}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="min-w-0 break-all font-mono">{screen.id}</span>
        <span className="text-xs text-muted-foreground">{CLI_LABEL[screen.cli]}</span>
        <StatusChip value={screen.killed === true ? "killed" : screen.state} />
        <span className="text-xs text-muted-foreground">{countOf(screen.turns, "turn")}</span>
        {screen.queued > 0 && (
          <span className="text-xs text-muted-foreground">{screen.queued} queued</span>
        )}
        {screen.model !== undefined && (
          <span className="text-xs text-muted-foreground">{screen.model}</span>
        )}
      </div>
      {screen.currentTool !== undefined && (
        <p className="text-xs">
          <span className="text-muted-foreground">Now: </span>
          {screen.currentTool}
          {screen.currentToolArgs !== undefined && (
            <span className="ms-1 break-all font-mono text-muted-foreground">
              {screen.currentToolArgs}
            </span>
          )}
        </p>
      )}
      <TailLines label="Tool calls" lines={screen.trace} max={MAX_TRACE_LINES} />
      <TailLines label="Output" lines={screen.outputTail} max={MAX_OUTPUT_LINES} />
      {screen.lastActivity !== undefined && (
        <p className="text-xs text-muted-foreground">Last activity: {screen.lastActivity}</p>
      )}
    </li>
  );
}

function ScreenList({
  label,
  screens,
}: {
  readonly label: string;
  readonly screens: readonly VibeScreen[];
}) {
  return (
    <section aria-label={label} className="min-w-0">
      <ul className="flex min-w-0 flex-col gap-3">
        {screens.map((screen) => (
          <ScreenRow key={screen.id} screen={screen} />
        ))}
      </ul>
    </section>
  );
}

/** A call still running, or cut off, says so: it does not claim an outcome it does not have yet. */
function unfinished(state: ToolCardState, pendingLabel: string): string | undefined {
  if (state.phase === "running" || state.phase === "partial") return pendingLabel;
  if (state.phase === "cancelled") return "Cancelled";
  return undefined;
}

function sendSummary(state: ToolCardState, send: VibeSend | undefined): string {
  const pending = unfinished(state, "Sending the message");
  if (pending !== undefined) return pending;
  if (state.isError || send === undefined) return "Message not delivered";
  if (send.mode === "turn") return `Turn started on ${send.id}`;
  if (send.mode === "steered") return `Steered ${send.id} mid-turn`;
  return `Queued for ${send.id}'s next turn`;
}

/** `vibe_send`: the worker a message reached, how omp delivered it, and the message the director sent. */
export const VibeSendRenderer: ToolRenderer = (props) => {
  const call = readVibeCall(props);
  const send = call.details?.send;
  const message = VibeSendArgsSchema.safeParse(call.state.args);
  const worker = send?.id ?? (message.success ? message.data.session : undefined);
  return (
    <VibeCard call={call} summary={sendSummary(call.state, send)} testId="send">
      <section className="flex min-w-0 flex-col gap-2 py-2">
        {worker !== undefined && <Fact label="Worker" value={worker} />}
        {send !== undefined && <Fact label="Delivered as" value={DELIVERY_LABEL[send.mode]} />}
        {send?.jobId !== undefined && (
          <p className="text-muted-foreground text-sm">Background turn</p>
        )}
        {message.success && (
          <blockquote className="min-w-0 whitespace-pre-wrap break-words text-sm">
            {message.data.message}
          </blockquote>
        )}
      </section>
      {send === undefined && <OmpText call={call} testId="t5-vibe-send-text" />}
    </VibeCard>
  );
};

function listSummary(state: ToolCardState, live: number, killed: number): string {
  const pending = unfinished(state, "Listing workers");
  if (pending !== undefined) return pending;
  if (state.isError) return "";
  const working = live === 0 ? "No live vibe workers" : countOf(live, "vibe worker");
  return killed === 0 ? working : `${working} · ${killed} killed`;
}

/** `vibe_list`: each live worker's screen, and the ids of the workers the director killed. */
export const VibeListRenderer: ToolRenderer = (props) => {
  const call = readVibeCall(props);
  const screens = call.details?.screens ?? [];
  const killed = call.details?.hiddenKilled ?? [];
  return (
    <VibeCard
      call={call}
      summary={listSummary(call.state, screens.length, killed.length)}
      testId="list"
    >
      {screens.length > 0 && <ScreenList label="Vibe workers" screens={screens} />}
      {killed.length > 0 && (
        <p className="text-sm text-muted-foreground" data-slot="t5-vibe-killed">
          Killed ({killed.length}): <span className="font-mono">{killed.join(", ")}</span>
        </p>
      )}
      {screens.length === 0 && <OmpText call={call} testId="t5-vibe-list-text" />}
    </VibeCard>
  );
};

function waitSummary(state: ToolCardState, wait: VibeWait | undefined): string {
  const pending = unfinished(state, "Waiting for worker turns");
  if (pending !== undefined) return pending;
  if (state.isError) return "";
  if (wait === undefined) return "Wait finished";
  if (wait.waiting === true) return "Waiting for worker turns";
  if (wait.timedOut === true) return "No turn settled before the wait ran out";
  const settled = wait.settled?.length ?? 0;
  if (settled > 0) return `${countOf(settled, "turn")} settled`;
  const running = wait.stillRunning?.length ?? 0;
  if (running > 0) return `Stopped waiting; ${countOf(running, "worker")} still running`;
  return "No turns in flight";
}

/**
 * `vibe_wait`: the turns that settled and their status, the workers still running, and the watched screens. A wait
 * that timed out says so and tells the director to wait again. The card never waits itself.
 */
export const VibeWaitRenderer: ToolRenderer = (props) => {
  const call = readVibeCall(props);
  const wait = call.details?.wait;
  const screens = call.details?.screens ?? [];
  const settled = wait?.settled ?? [];
  const stillRunning = wait?.stillRunning ?? [];
  const showsWaitText = wait?.timedOut !== true && wait?.waiting !== true && ompTextShown(call);
  return (
    <VibeCard call={call} summary={waitSummary(call.state, wait)} testId="wait">
      {screens.length > 0 && <ScreenList label="Watched vibe workers" screens={screens} />}
      {settled.length > 0 && (
        <ul aria-label="Settled turns" className="flex min-w-0 flex-col gap-1">
          {settled.map((turn) => (
            <li
              className="flex flex-wrap items-center gap-2 text-sm"
              data-slot="t5-vibe-settled"
              data-status={turn.status}
              key={turn.id}
            >
              <span className="min-w-0 break-all font-mono">{turn.id}</span>
              <StatusChip value={turn.status} />
              <span className="text-xs text-muted-foreground">Background turn</span>
            </li>
          ))}
        </ul>
      )}
      {stillRunning.length > 0 && !showsWaitText && (
        <p className="text-sm">
          <span className="text-muted-foreground">Still running: </span>
          <span className="break-all font-mono">{stillRunning.join(", ")}</span>
        </p>
      )}
      {wait?.waiting === true && (
        <p className="text-sm text-muted-foreground">Waiting for worker turns to settle.</p>
      )}
      {wait?.timedOut === true && (
        <p className="text-sm" role="status">
          No turn settled before the wait ran out. Wait again to keep waiting.
        </p>
      )}
      {wait?.timedOut !== true && wait?.waiting !== true && (
        <OmpText call={call} testId="t5-vibe-wait-text" />
      )}
    </VibeCard>
  );
};

function killSummary(
  state: ToolCardState,
  killed: VibeKill | undefined,
  worker: string | undefined,
): string {
  const stopping = worker === undefined ? "Stopping worker" : `Stopping worker ${worker}`;
  const pending = unfinished(state, stopping);
  if (pending !== undefined) return pending;
  if (!state.isError && killed !== undefined) return `Killed ${killed.id}`;
  return worker === undefined ? "Worker not killed" : `Worker ${worker} not killed`;
}

/** `vibe_kill`: the worker that was terminated, and whether its running turn was cancelled with it. */
export const VibeKillRenderer: ToolRenderer = (props) => {
  const call = readVibeCall(props);
  const killed = call.details?.killed;
  const target = VibeKillArgsSchema.safeParse(call.state.args);
  const worker = killed?.id ?? (target.success ? target.data.session : undefined);
  return (
    <VibeCard call={call} summary={killSummary(call.state, killed, worker)} testId="kill">
      {worker !== undefined && (
        <section className="flex min-w-0 flex-col gap-2 py-2">
          <Fact label="Worker" value={worker} />
          {killed !== undefined && (
            <p className="text-sm">
              {killed.cancelledTurn
                ? "Its running turn was cancelled."
                : "No running turn was cancelled."}
            </p>
          )}
        </section>
      )}
      {killed === undefined && <OmpText call={call} testId="t5-vibe-kill-text" />}
    </VibeCard>
  );
};
