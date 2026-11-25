import { PieceCutter } from "./cutter";
import { Resampler } from "./wav";

export interface CaptureEvents {
  /** A piece was cut (16 kHz samples), at a pause or at 30 s. */
  readonly onPiece: (samples: Int16Array) => void;
  /** How loud it is now, 0 to 1, about twelve times a second: the level line. */
  readonly onLevel: (level: number) => void;
  /**
   * The microphone stopped without being asked (iOS mutes a web app's in the background or when the phone locks, a
   * headset was unplugged): what was captured since the last piece is in `rest`.
   */
  readonly onStopped: (rest: Int16Array) => void;
}

export interface Capture {
  /** Ends the capture; gives back what was captured since the last piece. */
  stop(): Int16Array;
  /** What was captured since the last piece, the capture going on: saved every few seconds. */
  peek(): Int16Array;
}

/** Whether this browser can capture at all: a secure page with a microphone API and audio worklets. */
export function canCapture(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof AudioWorkletNode !== "undefined"
  );
}

/**
 * Starts the microphone (asking for it the first time): its samples go through an audio worklet to the page, are
 * brought to 16 kHz and cut into pieces (`PieceCutter`). Echo cancelling, noise suppression and gain control are the
 * browser's, as for a call.
 */
export async function startCapture(events: CaptureEvents): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const context = new AudioContext();
  try {
    await context.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url));
    if (context.state === "suspended") await context.resume();
  } catch (failure) {
    for (const track of stream.getTracks()) track.stop();
    void context.close();
    throw failure;
  }
  const source = context.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(context, "omp-pcm-tap");
  const resampler = new Resampler(context.sampleRate);
  const cutter = new PieceCutter();
  let ended = false;
  let level = 0;
  let lastLevelAt = 0;
  tap.port.onmessage = (message: MessageEvent<Float32Array>) => {
    if (ended) return;
    const block = message.data;
    let peak = 0;
    for (let i = 0; i < block.length; i++) peak = Math.max(peak, Math.abs(block[i] ?? 0));
    level = Math.max(peak, level * 0.6);
    const now = performance.now();
    if (now - lastLevelAt > 80) {
      lastLevelAt = now;
      events.onLevel(Math.min(1, level * 1.6));
    }
    for (const piece of cutter.push(resampler.push(block))) events.onPiece(piece);
  };
  source.connect(tap);
  const end = (): Int16Array => {
    if (ended) return new Int16Array(0);
    ended = true;
    tap.port.onmessage = null;
    source.disconnect();
    tap.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void context.close();
    return cutter.flush();
  };
  const [track] = stream.getAudioTracks();
  const stopped = (): void => {
    if (!ended) events.onStopped(end());
  };
  track?.addEventListener("ended", stopped);
  track?.addEventListener("mute", stopped);
  return { stop: end, peek: () => cutter.peek() };
}
