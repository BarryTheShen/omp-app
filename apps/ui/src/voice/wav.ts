/** Voice input's audio: 16 kHz mono 16-bit PCM, the rate speech models take, 32 kB a second. */
export const RATE = 16_000;

/** Samples as a WAV file: the 44-byte header and the samples, little-endian. */
export function encodeWav(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i] ?? 0, true);
  return bytes;
}

/**
 * Turns the microphone's samples (floats at the audio context's rate, 44.1 or 48 kHz) into 16 kHz 16-bit samples: each
 * output sample is the mean of the input samples it covers, which also keeps sounds above 8 kHz from folding back.
 * Blocks of any length go in, one after another; what a block leaves over is carried to the next.
 */
export class Resampler {
  readonly #step: number;
  #position = 0;
  #sum = 0;
  #count = 0;

  constructor(inputRate: number) {
    this.#step = inputRate / RATE;
  }

  push(input: Float32Array): Int16Array {
    const out = new Int16Array(Math.ceil((input.length + this.#count) / this.#step) + 1);
    let written = 0;
    for (let i = 0; i < input.length; i++) {
      this.#sum += input[i] ?? 0;
      this.#count += 1;
      this.#position += 1;
      if (this.#position >= this.#step) {
        this.#position -= this.#step;
        const mean = this.#sum / this.#count;
        out[written++] = Math.max(-32768, Math.min(32767, Math.round(mean * 32767)));
        this.#sum = 0;
        this.#count = 0;
      }
    }
    return out.subarray(0, written);
  }
}
