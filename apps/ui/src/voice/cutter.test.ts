import { describe, expect, test } from "vitest";
import { MAX_PIECE_MS, PieceCutter } from "./cutter";
import { encodeWav, RATE, Resampler } from "./wav";

/** `ms` of speech-like sound (a loud tone) or of quiet (a faint hiss). */
function sound(ms: number, loud: boolean): Int16Array {
  const out = new Int16Array(Math.round((RATE * ms) / 1000));
  for (let i = 0; i < out.length; i++)
    out[i] = loud ? Math.round(8000 * Math.sin(i / 7)) : (i % 7) - 3;
  return out;
}

function feed(cutter: PieceCutter, ...parts: Int16Array[]): Int16Array[] {
  const pieces: Int16Array[] = [];
  for (const part of parts)
    for (let at = 0; at < part.length; at += 1600)
      pieces.push(...cutter.push(part.subarray(at, at + 1600)));
  return pieces;
}

const ms = (piece: Int16Array | undefined) => Math.round(((piece?.length ?? 0) / RATE) * 1000);

describe("cutting a recording into pieces", () => {
  test("a pause before 10 s does not cut; the first pause after 10 s cuts inside it", () => {
    const cutter = new PieceCutter();
    const pieces = feed(
      cutter,
      sound(4000, true),
      sound(600, false),
      sound(6000, true),
      sound(800, false),
      sound(3000, true),
    );
    expect(pieces).toHaveLength(1);
    // 4 s + 0.6 s + 6 s of speech, then the cut, inside the 0.8 s pause that starts at 10.6 s.
    expect(ms(pieces[0])).toBeGreaterThan(10_600);
    expect(ms(pieces[0])).toBeLessThan(11_400);
    expect(ms(cutter.flush())).toBeGreaterThanOrEqual(3_300);
  });

  test("speech with no pause is cut at 30 s, and nothing is lost between the pieces", () => {
    const cutter = new PieceCutter();
    const total = sound(65_000, true);
    const pieces = feed(cutter, total);
    expect(pieces.length).toBe(2);
    for (const piece of pieces) expect(ms(piece)).toBeLessThanOrEqual(MAX_PIECE_MS);
    const rest = cutter.flush();
    expect(pieces.reduce((sum, piece) => sum + piece.length, 0) + rest.length).toBe(total.length);
  });

  test("peek shows the piece in the making without ending it", () => {
    const cutter = new PieceCutter();
    feed(cutter, sound(3000, true));
    expect(ms(cutter.peek())).toBe(3000);
    expect(cutter.pendingMs).toBe(3000);
    expect(ms(cutter.flush())).toBe(3000);
    expect(cutter.pendingMs).toBe(0);
  });
});

describe("audio format", () => {
  test("48 kHz floats become 16 kHz samples, a third as many, across blocks of any length", () => {
    const resampler = new Resampler(48_000);
    const input = new Float32Array(48_000).fill(0.5);
    const out = [resampler.push(input.subarray(0, 1000)), resampler.push(input.subarray(1000))];
    const samples = out.reduce((sum, block) => sum + block.length, 0);
    expect(samples).toBe(16_000);
    expect(out[1]?.[10]).toBe(Math.round(0.5 * 32767));
  });

  test("a WAV file says 16 kHz mono 16-bit and holds the samples", () => {
    const wav = encodeWav(Int16Array.from([1, -2, 300]));
    const view = new DataView(wav.buffer);
    expect(wav.length).toBe(44 + 6);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getInt16(46, true)).toBe(-2);
  });
});
