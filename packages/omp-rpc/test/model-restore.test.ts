import { describe, expect, test } from "bun:test";
import { savedModelFromOmpText } from "../src/session/model-restore";

describe("savedModelFromOmpText", () => {
  test("reads the model from omp's error line, not from the source line Bun prints above it", () => {
    // What `omp --mode rpc-ui --resume <file>` printed for a chat whose saved model is gone (omp 18.8.9).
    const stderr = [
      '636975 |           await es("restoreSessionModelDiscoveryFallback", () => c.refreshDiscoverableProviders(Ve, "online-if-uncached"));',
      `636980 |       throw new Error(\`Could not restore model \${Ct[0]}\`);`,
      "                     ^",
      "error: Could not restore model fake/gone-model",
      "      at a8u (/$bunfs/root/omp-linux-x64:636980:13)",
      "      at async Rg (/$bunfs/root/omp-linux-x64:636241:19)",
      "",
    ].join("\n");

    expect(savedModelFromOmpText(stderr)).toBe("fake/gone-model");
  });

  test("reads a model named by the reply to open_session, with a provider path and a tag", () => {
    expect(
      savedModelFromOmpText("Could not restore model openrouter/anthropic/claude-3.5:beta"),
    ).toBe("openrouter/anthropic/claude-3.5:beta");
  });

  test("a full stop after the model name is not part of the name", () => {
    expect(savedModelFromOmpText("Could not restore model fake/gone-model.")).toBe(
      "fake/gone-model",
    );
  });

  test("text that is not the refusal names no model", () => {
    expect(savedModelFromOmpText("omp exited (exit code 1)")).toBeUndefined();
  });
});
