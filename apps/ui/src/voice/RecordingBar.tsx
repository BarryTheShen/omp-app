import type { SpeechPiece } from "@omp-app/contracts";
import { ArrowUp, Check, Loader2, Mic, Pause, RotateCcw, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { VoiceSession, VoiceSnapshot } from "./session";

/** Bars in the level line: the last few seconds of loudness, newest on the right. */
const BARS = 28;

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The recording's length now, ticking while the microphone runs. */
function useElapsed(snapshot: VoiceSnapshot): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (snapshot.since === null) return;
    const timer = setInterval(() => tick((value) => value + 1), 250);
    return () => clearInterval(timer);
  }, [snapshot.since]);
  return snapshot.recordedMs + (snapshot.since === null ? 0 : performance.now() - snapshot.since);
}

/** The level line: each loudness the microphone reports pushes a bar in from the right. */
function useLevels(level: number, running: boolean): readonly number[] {
  const [levels, setLevels] = useState<readonly number[]>(() => Array(BARS).fill(0));
  useEffect(() => {
    if (!running) return;
    setLevels((before) => [...before.slice(1), level]);
  }, [level, running]);
  return levels;
}

/** One piece in the text above the bar: its words, a placeholder while it is written, or a failure with Retry. */
function PieceText({
  piece,
  onRetry,
}: {
  readonly piece: SpeechPiece;
  readonly onRetry: (index: number) => void;
}): ReactNode {
  if (piece.state === "done") return piece.text === "" ? null : <span>{piece.text} </span>;
  if (piece.state === "failed")
    return (
      <span className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-bad-ink/40 px-1.5 py-0.5 align-middle text-xs text-bad-ink">
        Couldn't transcribe {Math.round(piece.ms / 1000)} s
        <button
          type="button"
          className="inline-flex items-center gap-0.5 underline underline-offset-2"
          onClick={() => onRetry(piece.index)}
        >
          <RotateCcw aria-hidden="true" className="size-3" />
          Retry
        </button>
      </span>
    );
  return (
    <span className="text-t3">
      …<span className="sr-only">being transcribed</span>{" "}
    </span>
  );
}

/**
 * The message box while recording (V259): it takes the box's place at the box's height. Above, the text of each piece
 * as it comes; below, Cancel, Pause, the level line and timer, Send and Done. Pause turns the microphone off and keeps
 * the recording; Resume goes on in it. Done waits for the last pieces' text and puts the whole text into the box; Send
 * sends it at once. Cancel keeps the recording in Recent recordings. On a phone the row spans the width and Done is a
 * thumb's 56 pt.
 */
export function RecordingBar({
  session,
  snapshot,
  phone,
  onText,
  onCancel,
  onRecent,
}: {
  readonly session: VoiceSession;
  readonly snapshot: VoiceSnapshot;
  readonly phone: boolean;
  /** The recording's text, at Done (`send` false) or Send (`send` true). */
  readonly onText: (text: string, send: boolean) => void;
  readonly onCancel: () => void;
  readonly onRecent: () => void;
}): ReactNode {
  const elapsed = useElapsed(snapshot);
  const running = snapshot.phase === "recording";
  const levels = useLevels(snapshot.level, running);
  const done = useRef<HTMLButtonElement>(null);
  const textEnd = useRef<HTMLDivElement>(null);
  const [sendAfter, setSendAfter] = useState(false);
  const pieces = snapshot.recording?.pieces ?? [];

  // On a computer the bar takes the keys (Enter is Done, Esc is Cancel); a phone has no keyboard up.
  useEffect(() => {
    if (!phone) done.current?.focus({ preventScroll: true });
  }, [phone]);
  // New text keeps the end in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when the pieces change.
  useEffect(() => {
    textEnd.current?.scrollIntoView({ block: "nearest" });
  }, [pieces.length, snapshot.recording]);

  const finish = (send: boolean): void => {
    if (snapshot.phase === "finishing") return;
    setSendAfter(send);
    // In review a part failed and was shown: Done now takes the rest (the part stays in Recent recordings).
    void session.done(snapshot.phase === "review").then((text) => {
      if (text !== null) onText(text, send);
    });
  };
  const cancel = (): void => {
    void session.cancel().then(onCancel);
  };

  const finishing = snapshot.phase === "finishing";
  const paused = snapshot.phase === "paused";
  const status =
    snapshot.phase === "starting"
      ? "Starting the microphone…"
      : paused
        ? "Paused: the microphone is off. Resume to go on in the same recording."
        : snapshot.phase === "stopped"
          ? "The microphone stopped (the phone locked, or another app took it). Resume to go on."
          : snapshot.phase === "error"
            ? (snapshot.error ?? "The microphone could not start.")
            : finishing
              ? snapshot.unsent > 0
                ? `Sending the last ${snapshot.unsent === 1 ? "part" : `${snapshot.unsent} parts`}… they are saved on this device`
                : "Writing out the last part…"
              : snapshot.phase === "review"
                ? "A part couldn't be transcribed. Retry it, or press Done to use the rest: the part stays in Recent recordings with its audio."
                : snapshot.unsent > 1
                  ? `${snapshot.unsent} parts saved on this device; they go when the connection is back`
                  : null;
  const pauseOrResume = (): void => {
    if (running) session.pause();
    else if (paused || snapshot.phase === "stopped") void session.resume();
  };

  return (
    // The box's own frame, so the bar sits exactly where the box was. `min-w-0`: a fieldset is never narrower than its
    // content by default, so on a phone the row's buttons pushed Done past the screen's edge.
    <fieldset
      aria-label="Voice input"
      data-tour="voice-bar"
      className="composer-box relative min-w-0 rounded-[var(--box-r)] border border-l4 bg-card [--box-r:var(--r-card)]"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        } else if (event.key === "Enter" && !event.shiftKey && snapshot.phase !== "error") {
          event.preventDefault();
          finish(event.ctrlKey || event.metaKey);
        } else if (
          event.key.toLowerCase() === "p" &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        ) {
          event.preventDefault();
          pauseOrResume();
        }
      }}
    >
      <div
        aria-live="polite"
        className={`overflow-y-auto px-3.5 pt-3 text-t1 ${phone ? "max-h-[40dvh] text-base" : "max-h-[30dvh] text-sm"} leading-normal`}
      >
        {pieces.length === 0 ? (
          <p className="text-t3">
            {running ? "Listening… the text comes in as you pause." : (status ?? "\u00a0")}
          </p>
        ) : (
          <p className="break-words whitespace-pre-wrap">
            {pieces.map((piece) => (
              <PieceText
                key={piece.index}
                piece={piece}
                onRetry={(index) => void session.retry(index)}
              />
            ))}
            {running && <span className="text-t3">…</span>}
          </p>
        )}
        <div ref={textEnd} />
      </div>
      {status !== null && pieces.length > 0 && (
        <p
          role="status"
          className={`px-3.5 pt-1 text-xs ${snapshot.phase === "error" ? "text-bad-ink" : "text-t3"}`}
        >
          {status}
        </p>
      )}
      <div className={`flex items-center gap-2 ${phone ? "p-[3px] pt-2" : "px-2 pt-2 pb-2"}`}>
        <Button
          type="button"
          variant="ghost"
          size={phone ? "icon" : "icon-sm"}
          className={`text-t2 hover:text-t1 ${phone ? "size-11" : "tablet:size-11"}`}
          aria-label="Cancel: keep the recording in Recent recordings"
          title="Cancel (Esc): the recording stays in Recent recordings"
          onClick={cancel}
          disabled={finishing}
        >
          <X />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {running && (
            <Button
              type="button"
              variant="ghost"
              size={phone ? "icon" : "icon-sm"}
              className={`text-t2 hover:text-t1 ${phone ? "size-11" : "tablet:size-11"}`}
              aria-label="Pause"
              title="Pause (P): the microphone goes off; Resume goes on in the same recording"
              onClick={pauseOrResume}
            >
              <Pause />
            </Button>
          )}
          {paused || snapshot.phase === "stopped" || snapshot.phase === "error" ? (
            paused || snapshot.phase === "stopped" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={phone ? "h-11" : "tablet:h-11"}
                title="Resume (P): go on in the same recording"
                onClick={pauseOrResume}
              >
                <Mic /> Resume
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void session.start(snapshot.owner ?? "")}
              >
                <Mic /> Try again
              </Button>
            )
          ) : (
            <div
              aria-hidden="true"
              className="flex h-7 min-w-0 flex-1 items-center gap-[3px] overflow-hidden"
            >
              {levels.map((value, place) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: the bars are positions, not items.
                  key={place}
                  className={`w-[3px] shrink-0 rounded-full ${running ? "bg-primary" : "bg-l4"}`}
                  style={{ height: `${Math.max(12, Math.round(value * 100))}%` }}
                />
              ))}
            </div>
          )}
          <time className="shrink-0 text-xs text-t2 tabular-nums" title="Recorded">
            {clock(elapsed)}
          </time>
          {!phone && (
            <button
              type="button"
              className="shrink-0 text-xs text-t3 underline-offset-2 hover:text-t1 hover:underline"
              onClick={onRecent}
            >
              Recent
            </button>
          )}
        </div>
        {/* Done, then Send at the end, the highlighted one: the usual last step is sending. */}
        <Button
          ref={done}
          type="button"
          variant="outline"
          size={phone ? "icon" : "icon-sm"}
          className={phone ? "size-11" : "tablet:size-11"}
          aria-label="Done: put the text in the box"
          title="Done (Enter): the text goes into the box"
          onClick={() => finish(false)}
          disabled={finishing || snapshot.phase === "error"}
        >
          {finishing && !sendAfter ? <Loader2 className="animate-spin" /> : <Check />}
        </Button>
        <Button
          type="button"
          variant="default"
          size={phone ? "icon" : "icon-sm"}
          className={phone ? "size-14 rounded-full" : "tablet:size-11"}
          aria-label="Send now"
          title="Send now (Ctrl+Enter): the text goes as a message once every part is in"
          onClick={() => finish(true)}
          disabled={finishing || snapshot.phase === "error"}
        >
          {finishing && sendAfter ? <Loader2 className="animate-spin" /> : <ArrowUp />}
        </Button>
      </div>
    </fieldset>
  );
}
