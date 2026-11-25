import type { AppClient } from "@omp-app/client";
import { type SpeechRecording, SpeechToTextPort } from "@omp-app/contracts";
import { follow } from "../follow";
import { type Capture, startCapture } from "./capture";
import {
  beginRecording,
  drain,
  endRecording,
  keepPartial,
  keepPiece,
  recoverUnfinished,
  unsentCount,
} from "./local";
import { RATE } from "./wav";

/**
 * Where a recording is:
 * - `starting`: the microphone is being asked for;
 * - `recording`;
 * - `paused`: Pause turned the microphone off; what was said is kept, and Resume goes on in the same recording;
 * - `stopped`: the microphone stopped by itself (iOS in the background, a headset unplugged); Resume goes on;
 * - `finishing`: Done or Send was pressed, and the last pieces are on their way or being transcribed;
 * - `review`: every piece is in, and some could not be transcribed: they show with Retry, and Done takes the rest;
 * - `error`: the microphone could not start (refused, missing).
 */
export type VoicePhase =
  | "idle"
  | "starting"
  | "recording"
  | "paused"
  | "stopped"
  | "finishing"
  | "review"
  | "error";

export interface VoiceSnapshot {
  readonly phase: VoicePhase;
  readonly recordingId: string | null;
  /** The message box that started the recording: only it shows the bar (a page can show several chats). */
  readonly owner: string | null;
  /** Speech recorded so far, in ms, and when the current stretch of recording started (`performance.now()`). */
  readonly recordedMs: number;
  readonly since: number | null;
  readonly level: number;
  /** Pieces cut so far, and those still on this device (not on the server yet). */
  readonly pieces: number;
  readonly unsent: number;
  /** The server's view of the recording: each piece's text, or why it failed. */
  readonly recording: SpeechRecording | null;
  readonly error: string | null;
  /** Recordings a page left unfinished, found and sent on this load: Recent recordings holds them. */
  readonly recovered: readonly string[];
}

const IDLE: VoiceSnapshot = {
  phase: "idle",
  recordingId: null,
  owner: null,
  recordedMs: 0,
  since: null,
  level: 0,
  pieces: 0,
  unsent: 0,
  recording: null,
  error: null,
  recovered: [],
};

/** The piece in the making is saved this often. */
const PARTIAL_EVERY_MS = 5_000;
/** Pieces left on this device are sent again this often. */
const DRAIN_EVERY_MS = 10_000;

/** Why the microphone could not start, in words. */
function micError(failure: unknown): string {
  const name = failure instanceof DOMException ? failure.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "The microphone is blocked for this app. Allow it in the browser's settings for this site.";
  if (name === "NotFoundError") return "No microphone was found.";
  if (name === "NotReadableError") return "Another app is using the microphone.";
  return `The microphone could not start: ${failure instanceof Error ? failure.message : String(failure)}`;
}

/**
 * Voice input on this page (V259): one recording at a time. Its pieces are kept on this device and sent as they are
 * cut; the server transcribes them and its `recording` events bring the text. Done waits for every piece's text and
 * gives the whole of it; Cancel ends the recording and leaves it in Recent recordings. Nothing said is dropped: a
 * piece is on this device until the server has it, and on the server until it is discarded or swept.
 */
export class VoiceSession {
  readonly #client: AppClient;
  #snapshot: VoiceSnapshot = IDLE;
  readonly #listeners = new Set<() => void>();
  #capture: Capture | null = null;
  #startedAt = 0;
  #nextIndex = 0;
  /** The recording's capture has ended (Done, Cancel): what is left is waiting for the text. */
  #ended = false;
  #partialTimer: ReturnType<typeof setInterval> | undefined;
  #drainTimer: ReturnType<typeof setInterval> | undefined;
  #wakeLock: { release(): Promise<void> } | null = null;
  /** Pieces being written to this device: Done waits for them. */
  #writes: Promise<unknown> = Promise.resolve();
  readonly #stops: (() => void)[] = [];

  constructor(client: AppClient) {
    this.#client = client;
    this.#stops.push(
      follow(client.subscribe(SpeechToTextPort, "recording"), (recording) => {
        if (recording.id === this.#snapshot.recordingId) this.#set({ recording });
      }),
      client.onOutage(() => void this.#send()),
    );
    const online = (): void => void this.#send();
    window.addEventListener("online", online);
    this.#stops.push(() => window.removeEventListener("online", online));
    const visible = (): void => {
      if (document.visibilityState === "visible" && this.#capture !== null) void this.#lockScreen();
    };
    document.addEventListener("visibilitychange", visible);
    this.#stops.push(() => document.removeEventListener("visibilitychange", visible));
    // What a page left unfinished (a reload or crash mid-recording) is ended and sent now.
    void recoverUnfinished(null).then((recovered) => {
      if (recovered.length > 0) this.#set({ recovered });
      void this.#send();
    });
  }

  dispose(): void {
    this.#capture?.stop();
    clearInterval(this.#partialTimer);
    clearInterval(this.#drainTimer);
    void this.#wakeLock?.release().catch(() => undefined);
    for (const stop of this.#stops) stop();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): VoiceSnapshot => this.#snapshot;

  /** Starts a new recording for the box `owner`, asking for the microphone the first time. */
  async start(owner: string): Promise<void> {
    if (this.#snapshot.phase !== "idle" && this.#snapshot.phase !== "error") return;
    const id = crypto.randomUUID();
    this.#startedAt = Date.now();
    this.#nextIndex = 0;
    this.#ended = false;
    this.#set({
      ...IDLE,
      recovered: this.#snapshot.recovered,
      phase: "starting",
      recordingId: id,
      owner,
    });
    await beginRecording(id, this.#startedAt);
    await this.#openMic();
  }

  /**
   * Pauses: the microphone goes off (its light too), and what was said since the last piece is cut into one and sent,
   * so its text comes in while paused. The clock stops; Done, Send and Cancel work as while recording.
   */
  pause(): void {
    const id = this.#snapshot.recordingId;
    if (this.#snapshot.phase !== "recording" || id === null) return;
    const rest = this.#capture?.stop();
    this.#capture = null;
    this.#stopTimers();
    if (rest !== undefined) this.#piece(id, rest);
    this.#set({ phase: "paused", level: 0, ...this.#stretchEnded() });
    void this.#wakeLock?.release().catch(() => undefined);
    this.#wakeLock = null;
  }

  /** Goes on in the same recording, after Pause or after the microphone stopped by itself. */
  async resume(): Promise<void> {
    if (this.#snapshot.phase !== "paused" && this.#snapshot.phase !== "stopped") return;
    this.#set({ phase: "starting" });
    await this.#openMic();
  }

  /**
   * Ends the recording (the first time) and waits for every piece's text. With a piece that could not be transcribed it
   * stops at `review` and gives null, so the failure is seen and can be retried; `anyway` takes the text there is (the
   * failed piece stays in Recent recordings with its audio).
   */
  async done(anyway = false): Promise<string | null> {
    const id = this.#snapshot.recordingId;
    if (id === null) return "";
    this.#set({ phase: "finishing" });
    if (!this.#ended) await this.#end(id);
    const recording = await this.#waitForText(id, this.#nextIndex);
    const failed = recording?.pieces.some((piece) => piece.state === "failed") ?? false;
    if (failed && !anyway) {
      this.#set({ phase: "review" });
      return null;
    }
    this.#reset();
    return recording?.text ?? "";
  }

  /** Ends the recording without its text going anywhere: it stays in Recent recordings. */
  async cancel(): Promise<void> {
    const id = this.#snapshot.recordingId;
    if (id === null) {
      this.#reset();
      return;
    }
    if (!this.#ended) await this.#end(id);
    this.#reset();
  }

  async retry(index: number): Promise<void> {
    const id = this.#snapshot.recordingId;
    if (id === null) return;
    const recording = await this.#client.port(SpeechToTextPort).retry({ recordingId: id, index });
    this.#set({ recording });
  }

  dismissRecovered(): void {
    this.#set({ recovered: [] });
  }

  async #openMic(): Promise<void> {
    const id = this.#snapshot.recordingId;
    if (id === null) return;
    try {
      this.#capture = await startCapture({
        onPiece: (samples) => this.#piece(id, samples),
        onLevel: (level) => this.#set({ level }),
        onStopped: (rest) => {
          this.#piece(id, rest);
          this.#capture = null;
          this.#stopTimers();
          this.#set({ phase: "stopped", level: 0, ...this.#stretchEnded() });
        },
      });
    } catch (failure) {
      this.#set({ phase: "error", error: micError(failure) });
      return;
    }
    this.#set({ phase: "recording", since: performance.now(), error: null });
    void this.#lockScreen();
    this.#partialTimer = setInterval(() => {
      const samples = this.#capture?.peek();
      if (samples !== undefined)
        this.#writes = this.#writes.then(() =>
          keepPartial(id, this.#startedAt, this.#nextIndex, samples),
        );
    }, PARTIAL_EVERY_MS);
    this.#drainTimer = setInterval(() => void this.#send(), DRAIN_EVERY_MS);
  }

  /** A cut piece: kept on this device, then sent. A piece under 0.3 s (a click at Stop) is left out. */
  #piece(id: string, samples: Int16Array): void {
    if (samples.length < RATE * 0.3) return;
    const index = this.#nextIndex++;
    this.#set({ pieces: this.#nextIndex });
    this.#writes = this.#writes
      .then(() => keepPiece(id, this.#startedAt, index, samples))
      .then(() => this.#send());
  }

  async #end(id: string): Promise<void> {
    this.#ended = true;
    const rest = this.#capture?.stop();
    this.#capture = null;
    this.#stopTimers();
    if (rest !== undefined) this.#piece(id, rest);
    this.#set({ level: 0, ...this.#stretchEnded() });
    void this.#wakeLock?.release().catch(() => undefined);
    this.#wakeLock = null;
    await this.#writes;
    await endRecording(id, this.#startedAt, this.#nextIndex);
    await this.#send();
  }

  /** Waits until the server has `count` pieces of the recording, each transcribed or failed. */
  async #waitForText(id: string, count: number): Promise<SpeechRecording | null> {
    if (count === 0) return null;
    const settled = (recording: SpeechRecording | null): boolean =>
      recording !== null &&
      recording.pieces.length >= count &&
      recording.pieces.every((piece) => piece.state === "done" || piece.state === "failed");
    for (;;) {
      if (this.#snapshot.phase !== "finishing") return this.#snapshot.recording;
      if (settled(this.#snapshot.recording)) return this.#snapshot.recording;
      // The events may have come before this page listened: the list says too.
      const listed = await this.#client
        .port(SpeechToTextPort)
        .list({})
        .then((result) => result.recordings.find((each) => each.id === id) ?? null)
        .catch(() => null);
      if (listed !== null) this.#set({ recording: listed });
      if (settled(listed)) return listed;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await this.#send();
    }
  }

  async #send(): Promise<void> {
    await drain(this.#client);
    const unsent = await unsentCount(this.#snapshot.recordingId ?? undefined).catch(() => 0);
    if (this.#snapshot.recordingId !== null) this.#set({ unsent });
  }

  async #lockScreen(): Promise<void> {
    const lock = (
      navigator as { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }
    ).wakeLock;
    if (lock === undefined) return;
    try {
      this.#wakeLock = await lock.request("screen");
    } catch {
      // Refused (a hidden page, low battery): the recording goes on, the screen may sleep.
    }
  }

  #stretchEnded(): Pick<VoiceSnapshot, "recordedMs" | "since"> {
    const { since, recordedMs } = this.#snapshot;
    return {
      recordedMs: recordedMs + (since === null ? 0 : performance.now() - since),
      since: null,
    };
  }

  #stopTimers(): void {
    clearInterval(this.#partialTimer);
    clearInterval(this.#drainTimer);
    this.#partialTimer = undefined;
    this.#drainTimer = undefined;
  }

  #reset(): void {
    this.#set({ ...IDLE, recovered: this.#snapshot.recovered });
  }

  #set(change: Partial<VoiceSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    for (const listener of this.#listeners) listener();
  }
}
