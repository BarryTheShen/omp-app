import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { silentWav } from "./transcribe";
import { MIN_SPEECH_MS, SpeechDetector, speechMs, speechProbabilities } from "./vad";

/**
 * Silero VAD v5 computed here must give what Silero's own ONNX model gives under onnxruntime 1.23 (its 16 kHz branch,
 * windows of 512 samples with the 64 before them): the references below, to four places.
 * `speech-en.wav`: LibriSpeech 1272-128104-0001 (CC BY 4.0), "nor is mister quilter's manner less interesting than
 * his matter".
 */
const SPEECH = [
  0.0344, 0.024, 0.0175, 0.0626, 0.1079, 0.1158, 0.0953, 0.0788, 0.1005, 0.1087, 0.2016, 0.22,
  0.2954, 0.3222, 0.3302, 0.2534, 0.3695, 0.8503, 0.9803, 0.9741, 0.9907, 0.9959, 0.9967, 0.9964,
  0.9964, 0.9973, 0.9966, 0.9974, 0.9957, 0.9969, 0.9988, 0.9995, 0.9978, 0.9965, 0.9996, 0.9997,
  0.9997, 0.9997, 0.9957, 0.9874, 0.9938, 0.9994, 0.9991, 0.9988, 0.9987, 0.9989, 0.9996, 0.9997,
  0.9995, 0.9983, 0.9969, 0.9998, 0.9996, 0.9996, 0.9998, 0.9998, 0.9997, 1.0, 0.9997, 0.9996,
  0.9998, 0.9999, 0.9998, 0.9996, 0.9998, 0.9998, 0.9998, 0.9998, 0.9996, 0.9992, 0.9994, 0.9977,
  0.996, 0.9967, 0.9987, 0.9989, 0.9994, 0.9995, 0.9994, 0.9994, 0.995, 0.9966, 0.9994, 0.9999,
  0.9998, 0.9997, 0.9992, 0.9991, 0.9998, 0.9997, 0.9991, 0.9992, 0.9995, 0.9995, 0.9997, 0.9998,
  0.9886, 0.9963, 0.9996, 0.9996, 0.999, 0.9993, 0.9997, 0.9999, 0.9998, 0.9998, 0.9999, 0.9999,
  0.9999, 0.9998, 0.9995, 0.9994, 0.9998, 0.9999, 0.9999, 0.9999, 1.0, 1.0, 0.9994, 0.9971, 0.9969,
  0.9638, 0.9664, 0.9851, 0.9988, 1.0, 1.0, 0.9999, 0.9999, 0.9993, 0.9999, 0.9999, 0.9999, 0.9999,
  0.9998, 0.993, 0.9698, 0.9914, 0.9049, 0.6341, 0.1477, 0.0592, 0.0642, 0.0797, 0.0434, 0.0368,
  0.0298, 0.0271, 0.0209, 0.0388,
];
/** `0.2 sin(0.37 n) + 0.1 sin(1.91 n) + 0.05 sin(0.013 n)` over one second: a hum, not a voice. */
const HUM = [
  0.0729, 0.0614, 0.0274, 0.016, 0.0101, 0.0074, 0.0049, 0.0037, 0.0034, 0.003, 0.002, 0.0018,
  0.0016, 0.0014, 0.0012, 0.001, 0.0009, 0.0007, 0.0007, 0.0008, 0.0006, 0.0005, 0.0004, 0.0005,
  0.0004, 0.0003, 0.0003, 0.0003, 0.0003, 0.0003, 0.0003,
];

const fixture = join(import.meta.dir, "../../../../test/fixtures/speech-en.wav");

describe("the speech detector", () => {
  test("gives Silero's own probabilities for a recorded voice and for a hum", async () => {
    const speech = await speechProbabilities(new Uint8Array(await readFile(fixture)));
    expect(speech).toHaveLength(SPEECH.length);
    for (const [index, value] of speech.entries())
      expect(value).toBeCloseTo(SPEECH[index] ?? -1, 3);

    const detector = await SpeechDetector.create();
    const window = new Float32Array(512);
    for (let start = 0, index = 0; start + 512 <= 16000; start += 512, index++) {
      for (let i = 0; i < 512; i++) {
        const n = start + i;
        window[i] =
          0.2 * Math.sin(n * 0.37) + 0.1 * Math.sin(n * 1.91) + 0.05 * Math.sin(n * 0.013);
      }
      expect(detector.step(window)).toBeCloseTo(HUM[index] ?? -1, 3);
    }
  });

  test("hears seconds of voice in speech, and none in silence", async () => {
    expect(await speechMs(new Uint8Array(await readFile(fixture)))).toBeGreaterThan(3000);
    expect(await speechMs(silentWav(3000))).toBe(0);
    expect(MIN_SPEECH_MS).toBe(250);
  });
});
