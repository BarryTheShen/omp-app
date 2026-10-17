import {
  AppFailure,
  type MemoryBackendId,
  type MemoryCommandOperation,
  MemoryCommandResult,
} from "@omp-app/contracts";
import type { CommandParserContext, OmpCommandGatewayService } from "./gateway";

/**
 * omp v18.8.9 `builtin-lifecycle.ts:530-618` formats the stable maintenance replies (the block is
 * unchanged in v18.9.1): `Memory cleared.` and `Memory consolidation enqueued.`. The stats/diagnose
 * hooks return backend-owned text, while ACP mental-model maintenance returns its fixed unsupported
 * sentence from `memory-backend/messages.ts:16-19`. A1 returns typed status and bounded text.
 */
const CLEAR_REPLY = "Memory cleared.";
const ENQUEUED_REPLY = "Memory consolidation enqueued.";
const MM_UNSUPPORTED_REPLY =
  "Mental-model maintenance via /memory mm is unsupported in ACP mode; use the hindsight HTTP API directly.";
const MAX_TEXT_LENGTH = 200_000;
const BACKENDS = new Set<MemoryBackendId>(["off", "local", "hindsight", "mnemopi", "sharpshooter"]);

function unrecognized(command: string): AppFailure {
  return new AppFailure({
    code: "internal",
    message: `The app could not read omp's reply to ${command}.`,
    retryable: false,
  });
}

function operationOf(command: string): MemoryCommandOperation {
  const match = /^\/memory(?:\s+(.+))?$/u.exec(command);
  if (match === null) throw unrecognized(command);
  const words = (match[1] ?? "view").trim().toLowerCase().split(/\s+/u);
  const first = words[0] ?? "view";
  if (first === "mm") {
    const subcommand = words[1];
    if (subcommand === "list") return "mm-list";
    if (subcommand === "show") return "mm-show";
    if (subcommand === "history") return "mm-history";
    if (subcommand === "refresh") return "mm-refresh";
    if (subcommand === "reload") return "mm-reload";
    if (subcommand === "seed") return "mm-seed";
    if (subcommand === "delete") return "mm-delete";
    throw unrecognized(command);
  }
  if (
    first === "view" ||
    first === "stats" ||
    first === "diagnose" ||
    first === "enqueue" ||
    first === "rebuild" ||
    first === "clear" ||
    first === "reset"
  ) {
    return first;
  }
  throw unrecognized(command);
}

function oneOutput(context: CommandParserContext): string {
  if (context.agentInvoked) {
    throw new AppFailure({
      code: "internal",
      message: `omp sent ${context.command} to the model instead of running it.`,
      retryable: false,
    });
  }
  const [output, ...rest] = context.outputs;
  if (output === undefined || rest.length > 0) throw unrecognized(context.command);
  const text = output.text.trim();
  if (text.length === 0) throw unrecognized(context.command);
  return text;
}

function backendUnavailable(
  text: string,
  operation: "stats" | "diagnose",
): MemoryCommandResult | undefined {
  if (text === "Memory backend is off — there is nothing to show.") {
    return { operation, outcome: "unavailable", backend: "off", reason: "backend-off" };
  }
  const match = new RegExp(
    `^Memory ${operation} is not available for the (\\w+) backend\\.$`,
    "u",
  ).exec(text);
  const backend = match?.[1];
  if (backend !== undefined && BACKENDS.has(backend as MemoryBackendId)) {
    return {
      operation,
      outcome: "unavailable",
      backend: backend as MemoryBackendId,
      reason: "backend-unavailable",
    };
  }
  return undefined;
}

export function parseMemoryReply(context: CommandParserContext): MemoryCommandResult {
  const operation = operationOf(context.command);
  const text = oneOutput(context);
  if (text.length > MAX_TEXT_LENGTH) {
    throw new AppFailure({
      code: "internal",
      message: "The app rejected omp's /memory result because it was too large to display safely.",
      retryable: false,
    });
  }
  if (operation.startsWith("mm-")) {
    if (text !== MM_UNSUPPORTED_REPLY) throw unrecognized(context.command);
    return { operation, outcome: "unavailable", reason: "unsupported-acp" };
  }
  if (operation === "clear" || operation === "reset") {
    if (text !== CLEAR_REPLY) throw unrecognized(context.command);
    return { operation, outcome: "completed" };
  }
  if (operation === "enqueue" || operation === "rebuild") {
    if (text !== ENQUEUED_REPLY) throw unrecognized(context.command);
    return { operation, outcome: "completed" };
  }
  const unavailable =
    operation === "stats" || operation === "diagnose"
      ? backendUnavailable(text, operation)
      : undefined;
  if (unavailable !== undefined) return unavailable;
  return MemoryCommandResult.parse({ operation, outcome: "completed", text });
}

export function registerMemoryParser(gateway: OmpCommandGatewayService): void {
  gateway.registerCommandParser("memory", parseMemoryReply);
}
