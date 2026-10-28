import { describe, expect, test } from "bun:test";
import { type CommandParserContext, createOmpCommandGateway } from "./gateway";
import { parseModeChangeReply } from "./mode-parsers";

/*
 * Recorded from the installed omp 18.8.9 through its RPC mode with the fake model: each command's `command_output`
 * text exactly as omp wrote it, and a prompt acknowledgement with agentInvoked false (omp ran the text as a
 * command). The same texts are cited to omp v18.12.6 in mode-parsers.ts. `computerOn` is in the form of omp 18.12.6,
 * the release the app pins, which added `backgroundFallback` to the status line (builtin-modes.ts:213-243).
 */
const RECORDED = {
  slowUnsupported:
    "The current model has no slow mode: /slow uses the flex tier on OpenAI/Google models and low priority on Anthropic subscriptions.",
  computerOn:
    "Computer use enabled for this session. Computer use: enabled · prelude: active · configured: display=active, maxWidth=3840, maxHeight=2400, backgroundFallback=takeover",
  computerOff: "Computer use disabled for this session.",
  extendedOn: "Extended context enabled.",
  extendedOff: "Extended context disabled.",
  browserVisible: "Browser mode: visible",
  browserHeadless: "Browser mode: headless",
} as const;

/** The context the gateway hands a parser for one command whose command_output texts are `texts`. */
function replyTo(
  command: string,
  texts: readonly string[],
  agentInvoked = false,
): CommandParserContext {
  return {
    command,
    agentInvoked,
    outputs: texts.map((text) => ({ text })),
    sessionUpdates: [],
    configUpdates: [],
  };
}

describe("parseModeChangeReply on omp's recorded 18.8.9 replies", () => {
  test("/slow on and /slow off on a model without slow mode are unsupported, never applied", () => {
    expect(parseModeChangeReply(replyTo("/slow on", [RECORDED.slowUnsupported]))).toEqual({
      outcome: "unsupported",
      mode: "slow",
      reason: "model-has-no-slow-mode",
    });
    expect(parseModeChangeReply(replyTo("/slow off", [RECORDED.slowUnsupported]))).toEqual({
      outcome: "unsupported",
      mode: "slow",
      reason: "model-has-no-slow-mode",
    });
  });

  test("/computer on and /computer off are applied", () => {
    expect(parseModeChangeReply(replyTo("/computer on", [RECORDED.computerOn]))).toEqual({
      outcome: "applied",
      mode: "computer",
      on: true,
    });
    expect(parseModeChangeReply(replyTo("/computer off", [RECORDED.computerOff]))).toEqual({
      outcome: "applied",
      mode: "computer",
      on: false,
    });
  });

  test("/extended-context on and off are applied", () => {
    expect(parseModeChangeReply(replyTo("/extended-context on", [RECORDED.extendedOn]))).toEqual({
      outcome: "applied",
      mode: "extended-context",
      on: true,
    });
    expect(parseModeChangeReply(replyTo("/extended-context off", [RECORDED.extendedOff]))).toEqual({
      outcome: "applied",
      mode: "extended-context",
      on: false,
    });
  });

  test("/browser visible and /browser headless are applied for the window they asked for", () => {
    expect(parseModeChangeReply(replyTo("/browser visible", [RECORDED.browserVisible]))).toEqual({
      outcome: "applied",
      mode: "browser",
      visibility: "visible",
    });
    expect(parseModeChangeReply(replyTo("/browser headless", [RECORDED.browserHeadless]))).toEqual({
      outcome: "applied",
      mode: "browser",
      visibility: "headless",
    });
  });
});

describe("parseModeChangeReply on the other replies omp prints (cited to 18.12.6)", () => {
  test("Anthropic slow mode turned on, with or without a reset time, is applied", () => {
    expect(
      parseModeChangeReply(
        replyTo("/slow on", [
          "Slow mode on: continuing at low priority until your limit resets at 4:30 PM. Your weekly limit still applies, and responses may pause while waiting for spare capacity.",
        ]),
      ),
    ).toEqual({ outcome: "applied", mode: "slow", on: true });
    expect(
      parseModeChangeReply(
        replyTo("/slow on", [
          "Slow mode on: when your Claude subscription hits its session limit and Anthropic offers low priority, requests switch to it after any wrap-up allowance.",
        ]),
      ),
    ).toEqual({ outcome: "applied", mode: "slow", on: true });
  });

  test("a turn-on that the Claude usage limit stopped is refused with its reason", () => {
    expect(
      parseModeChangeReply(
        replyTo("/slow on", [
          "Slow mode off: at your Claude usage limit, requests may get a short wrap-up allowance, then wait for the limit to reset.",
        ]),
      ),
    ).toEqual({ outcome: "refused", mode: "slow", reason: "claude-usage-limit" });
  });

  test("computer use that cannot turn on in this session is unsupported", () => {
    expect(
      parseModeChangeReply(
        replyTo("/computer on", ["Computer use is unavailable in this session."]),
      ),
    ).toEqual({ outcome: "unsupported", mode: "computer", reason: "not-in-session" });
  });

  test("a browser window that is saved but did not restart is refused, and omp's error text is not passed on", () => {
    expect(
      parseModeChangeReply(
        replyTo("/browser visible", [
          "Browser mode set to visible, but restart failed: spawn chromium ENOENT\n  at /private/path",
        ]),
      ),
    ).toEqual({ outcome: "refused", mode: "browser", reason: "browser-restart-failed" });
  });
});

describe("a reply the parser does not recognise is unknown, never applied", () => {
  test("one unrecognised reply is unknown, carrying omp's own words as sent", () => {
    const words = "Slow mode is on.";
    expect(parseModeChangeReply(replyTo("/slow on", [words]))).toEqual({
      outcome: "unknown",
      mode: "slow",
      outputs: [words],
    });
  });

  test("a reply that reads as the other direction's change is unknown, not applied", () => {
    expect(parseModeChangeReply(replyTo("/slow on", ["Slow mode off."]))).toEqual({
      outcome: "unknown",
      mode: "slow",
      outputs: ["Slow mode off."],
    });
    expect(parseModeChangeReply(replyTo("/computer off", [RECORDED.computerOn]))).toEqual({
      outcome: "unknown",
      mode: "computer",
      outputs: [RECORDED.computerOn],
    });
    expect(parseModeChangeReply(replyTo("/browser visible", [RECORDED.browserHeadless]))).toEqual({
      outcome: "unknown",
      mode: "browser",
      outputs: [RECORDED.browserHeadless],
    });
  });

  test("a prompt sent to the model, several outputs, or none are unknown with omp's outputs unchanged", () => {
    expect(parseModeChangeReply(replyTo("/slow on", ["Slow mode on."], true))).toEqual({
      outcome: "unknown",
      mode: "slow",
      outputs: ["Slow mode on."],
    });
    expect(
      parseModeChangeReply(replyTo("/extended-context on", [RECORDED.extendedOn, "second"])),
    ).toEqual({
      outcome: "unknown",
      mode: "extended-context",
      outputs: [RECORDED.extendedOn, "second"],
    });
    expect(parseModeChangeReply(replyTo("/computer on", []))).toEqual({
      outcome: "unknown",
      mode: "computer",
      outputs: [],
    });
  });
});

describe("the mode-command parsers are registered for each command the app sends", () => {
  test("the app's gateway already has a parser under each mode name", () => {
    const gateway = createOmpCommandGateway({
      resolveSession: () => {
        throw new Error("not used in this test");
      },
    });
    for (const name of ["slow", "computer", "extended-context", "browser"]) {
      expect(() => gateway.registerCommandParser(name, () => "again")).toThrow(
        `Duplicate command parser registration for ${name}`,
      );
    }
  });
});
