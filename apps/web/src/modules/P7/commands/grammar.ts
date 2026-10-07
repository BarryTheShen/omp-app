import { SlashCommand } from "@omp-app/contracts";

export type P7CommandName = "context" | "stats" | "usage" | "compact";

export interface ParsedP7Command {
  readonly name: P7CommandName;
  readonly command: SlashCommand;
  readonly args: string;
}

export type P7CommandParseResult =
  | { readonly state: "valid"; readonly value: ParsedP7Command }
  | { readonly state: "invalid"; readonly message: string };

export interface StatsArguments {
  readonly port: number;
  readonly host: string;
}

export type StatsArgumentsResult =
  | { readonly state: "valid"; readonly value: StatsArguments }
  | { readonly state: "invalid"; readonly message: string };

export type UsageArguments =
  | { readonly kind: "show" }
  | { readonly kind: "reset"; readonly target: string | null };

export type UsageArgumentsResult =
  | { readonly state: "valid"; readonly value: UsageArguments }
  | { readonly state: "invalid"; readonly message: string };

export type CompactMode = "soft" | "remote" | "snapcompact";

export interface CompactArguments {
  readonly mode: CompactMode | null;
  readonly focus: string | null;
}

export type CompactArgumentsResult =
  | { readonly state: "valid"; readonly value: CompactArguments }
  | { readonly state: "invalid"; readonly message: string };

const STATS_DEFAULT_PORT = 3847;
const STATS_DEFAULT_HOST = "127.0.0.1";
const STATS_USAGE = "Usage: /stats [--port <port>] [--host <host>]";
const USAGE_USAGE = "Usage: /usage [show|reset [provider/credential-id|provider/active]]";

export function parseP7Command(input: string): P7CommandParseResult {
  const parsed = SlashCommand.safeParse(input);
  if (!parsed.success) {
    return { state: "invalid", message: "Enter a command starting with a slash." };
  }

  const body = parsed.data.slice(1);
  const separator = body.search(/\s/);
  const name = separator === -1 ? body : body.slice(0, separator);
  let commandName: P7CommandName;
  switch (name) {
    case "context":
      commandName = "context";
      break;
    case "stats":
      commandName = "stats";
      break;
    case "usage":
      commandName = "usage";
      break;
    case "compact":
      commandName = "compact";
      break;
    default:
      return { state: "invalid", message: "That command is not available here." };
  }

  return {
    state: "valid",
    value: {
      name: commandName,
      command: parsed.data,
      args: separator === -1 ? "" : body.slice(separator + 1),
    },
  };
}

type PortParseResult =
  | { readonly state: "valid"; readonly value: number }
  | { readonly state: "invalid"; readonly message: string };

function parsePort(value: string | undefined): PortParseResult {
  if (!value) {
    return { state: "invalid", message: `Missing port. ${STATS_USAGE}` };
  }
  if (!/^\d+$/.test(value)) {
    return { state: "invalid", message: `Invalid port: ${value}` };
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    return { state: "invalid", message: `Invalid port: ${value}` };
  }
  return { state: "valid", value: port };
}

export function parseStatsArgs(args: string): StatsArgumentsResult {
  const tokens = args.split(/\s+/).filter(Boolean);
  let port = STATS_DEFAULT_PORT;
  let host = STATS_DEFAULT_HOST;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;

    if (token === "--port" || token === "-p") {
      const parsed = parsePort(tokens[index + 1]);
      if (parsed.state === "invalid") return parsed;
      port = parsed.value;
      index += 1;
      continue;
    }
    if (token.startsWith("--port=")) {
      const parsed = parsePort(token.slice("--port=".length));
      if (parsed.state === "invalid") return parsed;
      port = parsed.value;
      continue;
    }
    if (token === "--host") {
      const value = tokens[index + 1];
      if (!value) {
        return { state: "invalid", message: `Missing host. ${STATS_USAGE}` };
      }
      host = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--host=")) {
      const value = token.slice("--host=".length);
      if (!value) {
        return { state: "invalid", message: `Missing host. ${STATS_USAGE}` };
      }
      host = value;
      continue;
    }
    return { state: "invalid", message: `Unknown option: ${token}. ${STATS_USAGE}` };
  }

  return { state: "valid", value: { port, host } };
}

export function parseUsageArgs(args: string): UsageArgumentsResult {
  const trimmed = args.trim();
  const separator = trimmed.search(/\s/);
  const verb = separator === -1 ? trimmed.toLowerCase() : trimmed.slice(0, separator).toLowerCase();
  const rest = separator === -1 ? "" : trimmed.slice(separator + 1).trim();

  if (!verb || (verb === "show" && !rest)) {
    return { state: "valid", value: { kind: "show" } };
  }
  if (verb === "reset") {
    return { state: "valid", value: { kind: "reset", target: rest || null } };
  }
  return { state: "invalid", message: USAGE_USAGE };
}

export function parseCompactArgs(args: string): CompactArgumentsResult {
  const trimmed = args.trim();
  if (!trimmed) {
    return { state: "valid", value: { mode: null, focus: null } };
  }

  const separator = trimmed.search(/\s/);
  const firstToken = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const normalized = firstToken.toLowerCase();
  const mode =
    normalized === "soft" || normalized === "remote" || normalized === "snapcompact"
      ? normalized
      : null;
  if (mode === null) {
    return { state: "valid", value: { mode: null, focus: trimmed } };
  }

  const focus = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  if (mode === "snapcompact" && focus) {
    return {
      state: "invalid",
      message:
        "/compact snapcompact does not take focus instructions (it archives history without an LLM summary).",
    };
  }
  return { state: "valid", value: { mode, focus: focus || null } };
}

export function validateP7Command(input: string): P7CommandParseResult {
  const parsed = parseP7Command(input);
  if (parsed.state === "invalid") return parsed;

  const validation =
    parsed.value.name === "stats"
      ? parseStatsArgs(parsed.value.args)
      : parsed.value.name === "usage"
        ? parseUsageArgs(parsed.value.args)
        : parsed.value.name === "compact"
          ? parseCompactArgs(parsed.value.args)
          : { state: "valid" as const };
  if (validation.state === "invalid") {
    return { state: "invalid", message: validation.message };
  }
  return parsed;
}
