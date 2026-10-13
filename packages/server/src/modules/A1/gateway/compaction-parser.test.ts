import { describe, expect, test } from "bun:test";
import { compactionOutcome } from "./compaction-parser";

describe("omp's words for a /compact that finished in the background", () => {
  test("a saved compaction, with or without its token counts", () => {
    expect(compactionOutcome("Compaction complete. Tokens: 120000 -> 28000 (saved 92000).")).toBe(
      "saved",
    );
    expect(compactionOutcome("Compaction complete.")).toBe("saved");
  });

  test("a failed compaction, with omp's reason", () => {
    expect(compactionOutcome("Compaction failed: nothing to compact.")).toBe("failed");
  });

  test("other output is not a compaction result", () => {
    expect(compactionOutcome("Compacting…")).toBeUndefined();
    expect(compactionOutcome("Done.")).toBeUndefined();
    expect(compactionOutcome("Context window: 128000 tokens (5% used)")).toBeUndefined();
  });
});
