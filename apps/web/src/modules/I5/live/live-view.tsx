import { MicIcon, MicOffIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LivePhase, LiveState } from "../contract";

/** Plain words for each phase; omp's phase names are not shown as they are. */
const PHASE_LABEL: Readonly<Record<LivePhase, string>> = {
  idle: "Not live",
  connecting: "Connecting",
  listening: "Listening",
  working: "Working",
  speaking: "Speaking",
  muted: "Microphone muted",
  stopping: "Stopping",
  ended: "Ended",
  error: "Stopped with an error",
};

const LIVE_PHASES: ReadonlySet<LivePhase> = new Set([
  "connecting",
  "listening",
  "working",
  "speaking",
  "muted",
  "stopping",
]);

function isLivePhase(phase: LivePhase): boolean {
  return LIVE_PHASES.has(phase);
}

export interface LiveVoiceControlProps {
  readonly state: LiveState;
  /** Why live voice cannot start in this chat, or undefined when it can. */
  readonly unavailableReason: string | undefined;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onToggleMute: () => void;
}

/**
 * Icon buttons: start while idle; mute and stop while live. The phase is read out to a screen reader when it changes,
 * from text that is visually hidden here. The words are shown by LiveStatusPanel, only while live, connecting or after
 * an error. A start that is unavailable says why in its title.
 */
export function LiveVoiceControl({
  state,
  unavailableReason,
  onStart,
  onStop,
  onToggleMute,
}: LiveVoiceControlProps) {
  const live = isLivePhase(state.phase);
  const muteLabel = state.muted ? "Unmute microphone" : "Mute microphone";
  return (
    <div className="flex shrink-0 items-center gap-(--space-2xs)">
      <span role="status" className="sr-only">
        {PHASE_LABEL[state.phase]}
      </span>
      {live ? (
        <>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={muteLabel}
            title={muteLabel}
            onClick={onToggleMute}
          >
            {state.muted ? <MicOffIcon /> : <MicIcon />}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Stop live voice"
            title="Stop live voice"
            onClick={onStop}
          >
            <SquareIcon />
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Start live voice"
          title={unavailableReason ?? "Start live voice"}
          disabled={unavailableReason !== undefined}
          onClick={onStart}
        >
          <MicIcon />
        </Button>
      )}
    </div>
  );
}

function LevelMeter({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <meter min={0} max={1} value={value} aria-label={label} className="h-1.5 w-16 align-middle" />
  );
}

export interface LiveStatusPanelProps {
  readonly state: LiveState;
}

/**
 * The words while live, connecting or after an error, the two levels while live, the lines still being spoken, and an
 * error. A finished line is in the chat already (R0 admits it), so the transcript drops it. The panel is empty otherwise.
 */
export function LiveStatusPanel({ state }: LiveStatusPanelProps) {
  const live = isLivePhase(state.phase);
  const words = live || state.phase === "error";
  const pending = state.transcripts.filter((line) => !line.final);
  if (!words && pending.length === 0 && state.error === null) return null;
  return (
    <div className="flex min-w-0 basis-full flex-col gap-(--space-2xs) text-xs">
      {words ? (
        <div className="text-muted-foreground flex flex-wrap items-center gap-(--space-xs)">
          <span data-testid="live-status">{PHASE_LABEL[state.phase]}</span>
          {live ? <LevelMeter label="Microphone level" value={state.levels.input} /> : null}
          {live ? <LevelMeter label="Speaker level" value={state.levels.output} /> : null}
        </div>
      ) : null}
      {pending.length > 0 ? (
        <section aria-label="Live transcript" aria-live="polite" className="min-w-0 text-sm">
          <ol className="flex flex-col gap-(--space-2xs)">
            {pending.map((line) => (
              <li key={`${line.role}:${line.turn}`} className="text-muted-foreground italic">
                <span className="font-medium not-italic">
                  {line.role === "user" ? "You" : "omp"}:{" "}
                </span>
                {line.text}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {state.error !== null ? (
        <p role="alert" className="text-destructive">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
