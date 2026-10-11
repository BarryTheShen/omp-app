import {
  AppFailure,
  type ModeChangeRequest,
  type ModeChangeResult,
  modeChangeFromCommand,
} from "@omp-app/contracts";
import type { CommandParserContext, OmpCommandGatewayService } from "./gateway";

/*
 * Typed parsers for the execution-mode commands `/slow`, `/computer`, `/extended-context` and `/browser`. Each
 * reply is read only when it is exactly one of the texts omp prints for that command and direction, cited to
 * omp v18.6.1 below and checked against the replies the installed omp 18.8.9 printed for the fake model. Any
 * other reply is `unknown`: it is never read as applied, and the app shows omp's own words as sent, as it did
 * before typed results.
 */

/** builtin-modes.ts:153-154, returned by :172 for any `/slow` change on a model without slow mode (on or off). */
const SLOW_UNSUPPORTED =
  "The current model has no slow mode: /slow uses the flex tier on OpenAI/Google models and low priority on Anthropic subscriptions.";
/** builtin-modes.ts:178 (flex tier) and :182 (Anthropic, no reset time): slow mode turned on. */
const SLOW_ON_FLEX = "Slow mode on: requests use the flex tier (lower cost, higher latency).";
const SLOW_ON_CLAUDE =
  "Slow mode on: when your Claude subscription hits its session limit and Anthropic offers low priority, requests switch to it after any wrap-up allowance.";
/** builtin-modes.ts:181: Anthropic, turned on until the limit resets; the reset clock is the only variable part. */
const SLOW_ON_CLAUDE_UNTIL_RESET =
  /^Slow mode on: continuing at low priority until your limit resets at .+\. Your weekly limit still applies, and responses may pause while waiting for spare capacity\.$/;
/** builtin-modes.ts:176: slow mode turned off. */
const SLOW_OFF = "Slow mode off.";
/** builtin-modes.ts:175: Anthropic's off reply; a turn-on that the usage limit stopped gets it too. */
const SLOW_OFF_CLAUDE_LIMIT =
  "Slow mode off: at your Claude usage limit, requests may get a short wrap-up allowance, then wait for the limit to reset.";

/** builtin-modes.ts:240 with the status line of :220-224: computer use turned on for this session. */
const COMPUTER_ON =
  /^Computer use enabled for this session\. Computer use: enabled · prelude: active · configured: display=[^,]+, maxWidth=\d+, maxHeight=\d+$/;
/** builtin-modes.ts:237: computer use cannot turn on in this session (its prelude is missing). */
const COMPUTER_UNAVAILABLE = "Computer use is unavailable in this session.";
/** builtin-modes.ts:241: computer use turned off for this session. */
const COMPUTER_OFF = "Computer use disabled for this session.";

/** builtin-modes.ts:201 and :205: extended context turned on and off. */
const EXTENDED_ON = "Extended context enabled.";
const EXTENDED_OFF = "Extended context disabled.";

/**
 * builtin-collaboration.ts:531 and :562: the browser window switched. The text is `Browser mode: <window>`.
 * builtin-collaboration.ts:526-527: the setting was saved but the browser did not restart; the error text after
 * the colon is omp's own and is not passed on.
 */
const BROWSER_RESTART_FAILED =
  /^Browser mode set to (headless|visible), but restart failed: [\s\S]+$/;

/** Reads one `/slow` reply for the requested direction, or null when the text is not one omp prints for it. */
function classifySlow(requested: boolean, text: string): ModeChangeResult | null {
  const mode = "slow";
  if (text === SLOW_UNSUPPORTED)
    return { outcome: "unsupported", mode, reason: "model-has-no-slow-mode" };
  if (requested) {
    if (text === SLOW_ON_FLEX || text === SLOW_ON_CLAUDE || SLOW_ON_CLAUDE_UNTIL_RESET.test(text)) {
      return { outcome: "applied", mode, on: true };
    }
    if (text === SLOW_OFF_CLAUDE_LIMIT)
      return { outcome: "refused", mode, reason: "claude-usage-limit" };
    return null;
  }
  if (text === SLOW_OFF || text === SLOW_OFF_CLAUDE_LIMIT)
    return { outcome: "applied", mode, on: false };
  return null;
}

/** Reads one `/computer` reply for the requested direction, or null when the text is not one omp prints for it. */
function classifyComputer(requested: boolean, text: string): ModeChangeResult | null {
  const mode = "computer";
  if (requested) {
    if (COMPUTER_ON.test(text)) return { outcome: "applied", mode, on: true };
    if (text === COMPUTER_UNAVAILABLE)
      return { outcome: "unsupported", mode, reason: "not-in-session" };
    return null;
  }
  return text === COMPUTER_OFF ? { outcome: "applied", mode, on: false } : null;
}

/** Reads one `/extended-context` reply for the requested direction, or null when omp printed something else. */
function classifyExtended(requested: boolean, text: string): ModeChangeResult | null {
  const mode = "extended-context";
  if (requested) return text === EXTENDED_ON ? { outcome: "applied", mode, on: true } : null;
  return text === EXTENDED_OFF ? { outcome: "applied", mode, on: false } : null;
}

/** Reads one `/browser` reply for the window the command asked for, or null when omp printed something else. */
function classifyBrowser(
  visibility: "headless" | "visible",
  text: string,
): ModeChangeResult | null {
  const mode = "browser";
  if (text === `Browser mode: ${visibility}`) return { outcome: "applied", mode, visibility };
  const failed = BROWSER_RESTART_FAILED.exec(text);
  if (failed !== null && failed[1] === visibility) {
    return { outcome: "refused", mode, reason: "browser-restart-failed" };
  }
  return null;
}

/** The typed outcome of one reply to a mode command, or null when the text is not one of omp's recognised replies. */
function classify(request: ModeChangeRequest, text: string): ModeChangeResult | null {
  if (request.mode === "browser") return classifyBrowser(request.visibility, text);
  if (request.mode === "slow") return classifySlow(request.requested, text);
  if (request.mode === "computer") return classifyComputer(request.requested, text);
  return classifyExtended(request.requested, text);
}

/**
 * Reads the reply to one mode command. A reply is typed only when omp printed it as the command's own single
 * output (not as a prompt to the model) and it is one of the texts above for that command and direction.
 * Everything else is `unknown`, carrying omp's outputs unchanged, so it can never be read as applied.
 */
export function parseModeChangeReply(context: CommandParserContext): ModeChangeResult {
  const request = modeChangeFromCommand(context.command);
  if (request === null) {
    throw new AppFailure({
      code: "internal",
      message: `The app could not read omp's reply to ${context.command}.`,
      retryable: false,
    });
  }
  const texts = context.outputs.map((output) => output.text);
  const [only, ...rest] = texts;
  const typed =
    context.agentInvoked || rest.length > 0 || only === undefined ? null : classify(request, only);
  if (typed !== null) return typed;
  return { outcome: "unknown", mode: request.mode, outputs: texts };
}

/** The command names whose replies this module reads; `registerOmpCommandParsers` registers them. */
const MODE_CHANGE_COMMANDS = ["slow", "computer", "extended-context", "browser"] as const;

/** Registers the mode-command parser on a gateway, under each command name it reads. */
export function registerModeChangeParsers(gateway: OmpCommandGatewayService): void {
  for (const name of MODE_CHANGE_COMMANDS)
    gateway.registerCommandParser(name, parseModeChangeReply);
}
