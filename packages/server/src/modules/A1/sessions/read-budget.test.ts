import { describe, expect, test } from "bun:test";
import {
  LISTING_READ_LIMITS,
  REFRESH_READ_LIMITS,
  ReadBudget,
  type ReadLimits,
} from "./read-budget";

const MiB = 1024 * 1024;

/**
 * A gate that holds reads until the test opens it. The server package compiles against ES2023, which has no
 * `Promise.withResolvers`, so the resolver is taken from the executor.
 */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { wait, open };
}

/** Lets every read the budget admits start: admission is synchronous, and a read starts a few microtasks later. */
async function admitted(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

interface Peak {
  readonly bytes: number;
  readonly files: number;
  readonly large: number;
}

/**
 * Runs one read per size. The reads hold their room until every read the budget admits has started, and the peak is what
 * was in flight then; the reads are then released and run to the end.
 */
async function peakOf(
  sizes: readonly number[],
  limits: ReadLimits = LISTING_READ_LIMITS,
): Promise<Peak> {
  const budget = new ReadBudget(limits);
  const held = gate();
  let bytes = 0;
  let files = 0;
  let large = 0;
  const peak = { bytes: 0, files: 0, large: 0 };
  const reads = sizes.map((size) =>
    budget.run(size, async () => {
      const isLarge = size > limits.largeBytes;
      files += 1;
      bytes += size;
      if (isLarge) large += 1;
      peak.files = Math.max(peak.files, files);
      peak.bytes = Math.max(peak.bytes, bytes);
      peak.large = Math.max(peak.large, large);
      await held.wait;
      files -= 1;
      bytes -= size;
      if (isLarge) large -= 1;
    }),
  );
  await admitted();
  // The peak is taken while every admitted read holds its room: the reads released after it may admit more.
  const atHold = { ...peak };
  held.open();
  await Promise.all(reads);
  return atHold;
}

describe("ReadBudget", () => {
  test("keeps the bytes of files in flight within 64 MiB", async () => {
    const peak = await peakOf(Array.from({ length: 10 }, () => 10 * MiB));
    expect(peak.bytes).toBe(60 * MiB);
    expect(peak.bytes).toBeLessThanOrEqual(64 * MiB);
  });

  test("keeps one file above 16 MiB in flight, and the next waits for it", async () => {
    const peak = await peakOf(Array.from({ length: 4 }, () => 20 * MiB));
    expect(peak.large).toBe(1);
    expect(peak.bytes).toBe(20 * MiB);
  });

  test("a file above the byte limit runs alone, and the reads behind it wait", async () => {
    const peak = await peakOf([100 * MiB, MiB, MiB]);
    expect(peak.files).toBe(1);
    expect(peak.bytes).toBe(100 * MiB);
  });

  test("keeps at most 24 files open, whatever their size", async () => {
    const peak = await peakOf(Array.from({ length: 100 }, () => 1024));
    expect(peak.files).toBe(24);
  });

  test("the refresh budget reads one large chat at a time, and at most four files at once", async () => {
    const large = await peakOf(
      Array.from({ length: 3 }, () => 20 * MiB),
      REFRESH_READ_LIMITS,
    );
    expect(large.files).toBe(1);
    const small = await peakOf(
      Array.from({ length: 10 }, () => 1024),
      REFRESH_READ_LIMITS,
    );
    expect(small.files).toBe(4);
  });

  test("gives the room back when a read fails, so the reads behind it still run", async () => {
    const budget = new ReadBudget();
    const failing = budget.run(60 * MiB, async () => {
      throw new Error("read failed");
    });
    await expect(failing).rejects.toThrow("read failed");
    await expect(budget.run(60 * MiB, async () => "next")).resolves.toBe("next");
  });
});
