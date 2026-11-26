/**
 * Which parts of a recording are a human voice: Silero VAD v5 (snakers4/silero-vad, MIT; its 16 kHz weights in
 * `silero-vad-16k.bin`, float32, in `LAYERS` order), computed here in plain TypeScript so the server needs no model
 * runtime. Each 32 ms window (512 samples, with the 64 before it) gets a probability of speech, as Silero's own
 * `OnnxWrapper` gives it: a 256-point transform of the window into 4 frames, four convolutions, an LSTM cell carried
 * from window to window, and a 1×1 output layer.
 *
 * Why (2026-11-25): the transcription model writes a sentence for sounds that are not speech. Measured on 400 ESC-50
 * sounds and 300 ASCEND speech clips, a part with under 250 ms of speech by this detector held no speech in every clip
 * of a second or more, and 40 of the 46 sounds that drew text fell under it.
 */
import weightsFile from "./silero-vad-16k.bin" with { type: "file" };

const RATE = 16_000;
const WINDOW = 512;
const CONTEXT = 64;
/** A window is speech above this probability (Silero's own default). */
const SPEECH_PROBABILITY = 0.5;
/**
 * A part with less voice than this is not sent to be transcribed. On ASCEND every speech clip of a second or more had
 * more; what fell under it alone was a lone filler ("嗯", "对") said as a whole recording.
 */
export const MIN_SPEECH_MS = 250;
/** Windows computed between two turns of the event loop, so a long part never holds up the server. */
const WINDOWS_PER_TURN = 64;

/** The weights' shapes, in the file's order. */
const LAYERS = [
  ["basis", 258 * 256],
  ["e0w", 128 * 129 * 3],
  ["e0b", 128],
  ["e1w", 64 * 128 * 3],
  ["e1b", 64],
  ["e2w", 64 * 64 * 3],
  ["e2b", 64],
  ["e3w", 128 * 64 * 3],
  ["e3b", 128],
  ["wih", 512 * 128],
  ["whh", 512 * 128],
  ["bih", 512],
  ["bhh", 512],
  ["dw", 128],
  ["db", 1],
] as const;
type Weights = Record<(typeof LAYERS)[number][0], Float32Array>;

let loading: Promise<Weights> | undefined;

/** The weights, read once from the file bundled with the server. */
function weights(): Promise<Weights> {
  loading ??= Bun.file(weightsFile)
    .arrayBuffer()
    .then((buffer) => {
      const all = new Float32Array(buffer);
      const out = {} as Weights;
      let at = 0;
      for (const [name, size] of LAYERS) {
        out[name] = all.subarray(at, at + size);
        at += size;
      }
      if (at !== all.length)
        throw new Error(`The speech detector's weights have ${all.length} values, not ${at}.`);
      return out;
    });
  return loading;
}

/** A 1-D convolution over `length` steps of `inputs` channels, padded `pad` on each side, then ReLU. */
function convRelu(
  input: Float32Array,
  inputs: number,
  length: number,
  weight: Float32Array,
  bias: Float32Array,
  outputs: number,
  stride: number,
): { values: Float32Array; length: number } {
  const kernel = 3;
  const pad = 1;
  const outLength = Math.floor((length + 2 * pad - kernel) / stride) + 1;
  const values = new Float32Array(outputs * outLength);
  for (let o = 0; o < outputs; o++) {
    for (let t = 0; t < outLength; t++) {
      let sum = bias[o] ?? 0;
      for (let i = 0; i < inputs; i++) {
        const row = (o * inputs + i) * kernel;
        for (let k = 0; k < kernel; k++) {
          const from = t * stride + k - pad;
          if (from >= 0 && from < length)
            sum += (weight[row + k] ?? 0) * (input[i * length + from] ?? 0);
        }
      }
      values[o * outLength + t] = sum > 0 ? sum : 0;
    }
  }
  return { values, length: outLength };
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/** Silero VAD over one stream of 16 kHz samples: `step` takes each 512-sample window in order. */
export class SpeechDetector {
  readonly #w: Weights;
  #h = new Float32Array(128);
  #c = new Float32Array(128);
  #context = new Float32Array(CONTEXT);

  private constructor(w: Weights) {
    this.#w = w;
  }

  static async create(): Promise<SpeechDetector> {
    return new SpeechDetector(await weights());
  }

  /** The probability that this window (512 samples, -1 to 1) is speech. */
  step(window: Float32Array): number {
    const w = this.#w;
    // The 64 samples before it, the window, and 64 more reflected at the end (the model's own padding).
    const x = new Float32Array(CONTEXT + WINDOW + 64);
    x.set(this.#context, 0);
    x.set(window, CONTEXT);
    const last = CONTEXT + WINDOW - 1;
    for (let i = 0; i < 64; i++) x[last + 1 + i] = x[last - 1 - i] ?? 0;
    this.#context = window.slice(WINDOW - CONTEXT);
    // The transform: 4 frames of 256 samples, 128 apart; 129 magnitudes each.
    const frames = 4;
    const spectrum = new Float32Array(129 * frames);
    for (let f = 0; f < frames; f++) {
      for (let bin = 0; bin < 129; bin++) {
        let re = 0;
        let im = 0;
        const reRow = bin * 256;
        const imRow = (bin + 129) * 256;
        for (let j = 0; j < 256; j++) {
          const sample = x[f * 128 + j] ?? 0;
          re += (w.basis[reRow + j] ?? 0) * sample;
          im += (w.basis[imRow + j] ?? 0) * sample;
        }
        spectrum[bin * frames + f] = Math.sqrt(re * re + im * im);
      }
    }
    const e0 = convRelu(spectrum, 129, frames, w.e0w, w.e0b, 128, 1);
    const e1 = convRelu(e0.values, 128, e0.length, w.e1w, w.e1b, 64, 2);
    const e2 = convRelu(e1.values, 64, e1.length, w.e2w, w.e2b, 64, 2);
    const e3 = convRelu(e2.values, 64, e2.length, w.e3w, w.e3b, 128, 1);
    // The LSTM cell, on the first (only) step: gates in, forget, cell, out.
    const gates = new Float32Array(512);
    for (let g = 0; g < 512; g++) {
      let sum = (w.bih[g] ?? 0) + (w.bhh[g] ?? 0);
      const row = g * 128;
      for (let i = 0; i < 128; i++) {
        sum +=
          (w.wih[row + i] ?? 0) * (e3.values[i * e3.length] ?? 0) +
          (w.whh[row + i] ?? 0) * (this.#h[i] ?? 0);
      }
      gates[g] = sum;
    }
    const h = new Float32Array(128);
    const c = new Float32Array(128);
    let out = w.db[0] ?? 0;
    for (let i = 0; i < 128; i++) {
      const input = sigmoid(gates[i] ?? 0);
      const forget = sigmoid(gates[128 + i] ?? 0);
      const cell = Math.tanh(gates[256 + i] ?? 0);
      const output = sigmoid(gates[384 + i] ?? 0);
      c[i] = forget * (this.#c[i] ?? 0) + input * cell;
      h[i] = output * Math.tanh(c[i] ?? 0);
      const hidden = h[i] ?? 0;
      out += (w.dw[i] ?? 0) * (hidden > 0 ? hidden : 0);
    }
    this.#h = h;
    this.#c = c;
    return sigmoid(out);
  }
}

/** Each 32 ms window's speech probability in a 16 kHz mono 16-bit WAV (44-byte header, as the pages send). */
export async function speechProbabilities(wav: Uint8Array): Promise<number[]> {
  const detector = await SpeechDetector.create();
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const samples = Math.max(0, Math.floor((wav.length - 44) / 2));
  const probabilities: number[] = [];
  const window = new Float32Array(WINDOW);
  for (let start = 0; start + WINDOW <= samples; start += WINDOW) {
    for (let i = 0; i < WINDOW; i++) window[i] = view.getInt16(44 + (start + i) * 2, true) / 32768;
    probabilities.push(detector.step(window));
    if (probabilities.length % WINDOWS_PER_TURN === 0)
      await new Promise((resolve) => setImmediate(resolve));
  }
  return probabilities;
}

/** How many ms of a WAV the detector takes for speech. */
export async function speechMs(wav: Uint8Array): Promise<number> {
  const probabilities = await speechProbabilities(wav);
  return (probabilities.filter((p) => p > SPEECH_PROBABILITY).length * WINDOW * 1000) / RATE;
}
