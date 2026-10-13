import { describe, expect, test } from "bun:test";
import { ThreadId } from "../src/core/ids";
import {
  ModeChangeArgs,
  ModeChangeRequest,
  ModeChangeResult,
  modeChangeCommand,
  modeChangeFromCommand,
} from "../src/ports/A1/omp-command-gateway";

const SPELLED = [
  "/slow on",
  "/slow off",
  "/computer on",
  "/computer off",
  "/extended-context on",
  "/extended-context off",
  "/browser headless",
  "/browser visible",
];

describe("mode-change spellings", () => {
  test("every spelling the app sends reads back to the request it stands for", () => {
    for (const command of SPELLED) {
      const request = modeChangeFromCommand(command);
      expect(request, command).not.toBeNull();
      if (request === null) throw new Error(`no request for ${command}`);
      expect(modeChangeCommand(request)).toBe(command);
    }
  });

  test("any other text, including omp's bare toggles and status forms, is not a mode change", () => {
    for (const text of [
      "/slow",
      "/slow status",
      "/fast on",
      "/browser",
      "/computer toggle",
      "slow on",
    ]) {
      expect(modeChangeFromCommand(text), text).toBeNull();
    }
  });

  test("omp reads a colon spelling as the spaced one, so /slow:on is the same request as /slow on", () => {
    expect(modeChangeFromCommand("/slow:on")).toEqual({ mode: "slow", requested: true });
    expect(modeChangeFromCommand("/extended-context:off")).toEqual({
      mode: "extended-context",
      requested: false,
    });
    expect(modeChangeFromCommand("/browser:visible")).toEqual({
      mode: "browser",
      visibility: "visible",
    });
    expect(modeChangeFromCommand("/slow:status")).toBeNull();
    expect(modeChangeFromCommand("/fast:on")).toBeNull();
  });
});

describe("mode-change requests and arguments", () => {
  test("a toggle needs its mode and a requested value; the browser needs a window", () => {
    expect(ModeChangeRequest.parse({ mode: "slow", requested: true })).toEqual({
      mode: "slow",
      requested: true,
    });
    expect(ModeChangeRequest.parse({ mode: "browser", visibility: "visible" })).toEqual({
      mode: "browser",
      visibility: "visible",
    });
    expect(ModeChangeRequest.safeParse({ mode: "fast", requested: true }).success).toBe(false);
    expect(ModeChangeRequest.safeParse({ mode: "browser", requested: true }).success).toBe(false);
  });

  test("the arguments carry the thread and the request, and nothing else", () => {
    const threadId = ThreadId.parse("thread-contract-1");
    const withExtra: unknown = {
      threadId,
      request: { mode: "computer", requested: false },
      extra: 1,
    };
    expect(
      ModeChangeArgs.parse({ threadId, request: { mode: "computer", requested: false } }),
    ).toEqual({ threadId, request: { mode: "computer", requested: false } });
    expect(ModeChangeArgs.safeParse(withExtra).success).toBe(false);
  });
});

describe("mode-change results", () => {
  test("the four typed outcomes and the unknown fallback parse as themselves", () => {
    const outcomes: ModeChangeResult[] = [
      { outcome: "applied", mode: "slow", on: true },
      { outcome: "applied", mode: "browser", visibility: "visible" },
      { outcome: "refused", mode: "browser", reason: "browser-restart-failed" },
      { outcome: "unsupported", mode: "slow", reason: "model-has-no-slow-mode" },
      { outcome: "unknown", mode: "slow", outputs: ["Slow mode is on."] },
    ];
    for (const outcome of outcomes) {
      expect(ModeChangeResult.parse(outcome)).toEqual(outcome);
    }
  });

  test("an outcome with an unknown reason, or a missing field, is rejected", () => {
    expect(
      ModeChangeResult.safeParse({ outcome: "refused", mode: "slow", reason: "omp-says-no" })
        .success,
    ).toBe(false);
    expect(ModeChangeResult.safeParse({ outcome: "unknown", mode: "slow" }).success).toBe(false);
    expect(ModeChangeResult.safeParse({ outcome: "applied", mode: "slow" }).success).toBe(false);
  });
});
