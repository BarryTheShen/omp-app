import { describe, expect, test } from "bun:test";
import { redactPrivateKeyBlocks } from "./private-key-blocks";

// The PR gate rejects added lines that look like a private key, so headers are built at runtime.
const DASHES = "-----";
const begin = (kind = ""): string => `${DASHES}BEGIN ${kind ? `${kind} ` : ""}PRIVATE KEY${DASHES}`;
const end = (kind = ""): string => `${DASHES}END ${kind ? `${kind} ` : ""}PRIVATE KEY${DASHES}`;

// The single pattern that redactPrivateKeyBlocks replaces (service.ts before #869). It is the reference: the new pass
// must give the same text for every input, only faster.
const SINGLE_PATTERN = new RegExp(
  `${DASHES}BEGIN [A-Z ]*PRIVATE KEY${DASHES}[\\s\\S]*?${DASHES}END [A-Z ]*PRIVATE KEY${DASHES}`,
  "g",
);
const reference = (text: string): string => text.replace(SINGLE_PATTERN, "<redacted>");

// The growth guard (#869): unclosed BEGIN headers are what made the old pattern quadratic. When the pass is linear,
// four times the text takes about four times as long; the old pattern took about sixteen times as long.
const GROWTH_SMALL = 12_500;
const GROWTH_LARGE = 50_000;
const GROWTH_LIMIT = 8;
const GROWTH_FLOOR_MS = 0.25;
const GROWTH_RUNS = 5;

/** `length` characters of BEGIN headers, none with an END after it. */
function unclosedHeaders(length: number): string {
  const header = begin();
  return header.repeat(Math.ceil(length / header.length)).slice(0, length);
}

/** The fastest of `GROWTH_RUNS` timed calls, after one untimed call that compiles the regex and warms the JIT. */
function fastestMs(run: () => unknown): number {
  run();
  let fastest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < GROWTH_RUNS; index += 1) {
    const started = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

describe("redactPrivateKeyBlocks", () => {
  test("replaces a closed block and keeps the text around it", () => {
    expect(redactPrivateKeyBlocks(`before ${begin("RSA")}\nMIIE\n${end("RSA")} after`)).toBe(
      "before <redacted> after",
    );
  });

  test.each([
    ["two closed blocks", `${begin()}a${end()} x ${begin("EC")}b${end("EC")}`],
    ["an unclosed header with nothing after it", `keep ${begin()} the rest`],
    ["a closed block, then an unclosed header", `${begin()}a${end()} ${begin()} tail`],
    [
      "an unclosed header, then a closed block (the block starts at the first header)",
      `${begin()} a ${begin()} b ${end()}`,
    ],
    ["a header inside a block is part of the block", `${begin("A")}a${begin("B")}b${end("B")}c`],
    ["an empty block", `${begin()}${end()}`],
    ["an end header with no begin", `${end()} x`],
    [
      "a partial header",
      `${DASHES}BEGIN PRIVATE KEY (not a header) ${DASHES}END PRIVATE KEY${DASHES}`,
    ],
    ["text with no key", "plain text with BEGIN, END and KEY-----"],
    ["an empty string", ""],
  ])("%s: the same text as the single pattern", (_name, text) => {
    expect(redactPrivateKeyBlocks(text)).toBe(reference(text));
  });

  test("matches the single pattern on seeded random text, including near-miss headers", () => {
    // Fragments that build real headers, partial ones, and runs of capitals and spaces.
    const fragments = [
      `${DASHES}BEGIN `,
      `${DASHES}END `,
      "PRIVATE KEY-----",
      "RSA ",
      "PRIVATE ",
      "KEY",
      DASHES,
      "x",
      " ",
      "\n",
      "A-",
    ];
    // A 32-bit linear congruential generator: the same inputs on every run.
    let seed = 7;
    const next = (limit: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % limit;
    };
    const mismatches: string[] = [];
    for (let trial = 0; trial < 2_000; trial += 1) {
      let text = "";
      const count = next(40);
      for (let index = 0; index < count; index += 1)
        text += fragments[next(fragments.length)] ?? "";
      if (redactPrivateKeyBlocks(text) !== reference(text)) mismatches.push(JSON.stringify(text));
    }
    expect(mismatches).toEqual([]);
  });

  test("unclosed BEGIN headers take linear time: 12,500 to 50,000 characters", () => {
    const small = unclosedHeaders(GROWTH_SMALL);
    const large = unclosedHeaders(GROWTH_LARGE);
    // Nothing is closed, so the text comes back unchanged: a fast wrong answer must not pass the timing check.
    expect(redactPrivateKeyBlocks(large)).toBe(large);
    const smallMs = fastestMs(() => redactPrivateKeyBlocks(small));
    const largeMs = fastestMs(() => redactPrivateKeyBlocks(large));
    // The small run is floored: below a quarter of a millisecond, timer noise would decide the ratio.
    expect(largeMs / Math.max(smallMs, GROWTH_FLOOR_MS)).toBeLessThan(GROWTH_LIMIT);
  });
});
