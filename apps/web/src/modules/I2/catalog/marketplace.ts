import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CommandRunResult,
  OmpCommandGateway as OmpCommandGatewayPort,
  type PortCallOptions,
  type ThreadId,
} from "@omp-app/contracts";
import { type I2CapabilityKey, I2CapabilityKeys, sanitizeCatalogText } from "./contract";

const MAX_OUTPUTS = 256;
const MAX_OUTPUT_TEXT = 4_000;
const MAX_UPDATES = 256;
const URL_CREDENTIALS = /([a-z][a-z\d+.-]*:\/\/)[^/\s@]+@/gi;
const QUERY_CREDENTIALS = /([?&](?:token|secret|password|authorization|api[_-]?key)=)[^&#\s]+/gi;
const BEARER_CREDENTIALS = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
export type MarketplaceOperation =
  | "add"
  | "discover"
  | "help"
  | "install"
  | "installed"
  | "list"
  | "remove"
  | "uninstall"
  | "update"
  | "upgrade"
  | "plugins-list"
  | "plugins-enable"
  | "plugins-disable"
  | "reload-plugins";

export type MarketplaceRequest =
  | { readonly operation: "add"; readonly threadId: ThreadId; readonly source: string }
  | { readonly operation: "discover"; readonly threadId: ThreadId; readonly marketplace?: string }
  | { readonly operation: "help"; readonly threadId: ThreadId }
  | {
      readonly operation: "install";
      readonly threadId: ThreadId;
      readonly name: string;
      readonly marketplace?: string;
    }
  | { readonly operation: "installed"; readonly threadId: ThreadId }
  | { readonly operation: "list"; readonly threadId: ThreadId }
  | { readonly operation: "remove"; readonly threadId: ThreadId; readonly marketplace: string }
  | {
      readonly operation: "uninstall";
      readonly threadId: ThreadId;
      readonly name: string;
      readonly marketplace?: string;
    }
  | { readonly operation: "update"; readonly threadId: ThreadId; readonly marketplace?: string }
  | {
      readonly operation: "upgrade";
      readonly threadId: ThreadId;
      readonly name?: string;
      readonly marketplace?: string;
    }
  | { readonly operation: "plugins-list"; readonly threadId: ThreadId }
  | {
      readonly operation: "plugins-enable" | "plugins-disable";
      readonly threadId: ThreadId;
      readonly name: string;
      readonly marketplace?: string;
      readonly scope?: "user" | "project";
    }
  | { readonly operation: "reload-plugins"; readonly threadId: ThreadId };

export interface MarketplaceOutput {
  readonly text: string;
  readonly emittedAt?: string;
}

export interface MarketplaceResult {
  readonly operation: MarketplaceOperation;
  readonly status: CommandRunResult["status"];
  readonly agentInvoked: boolean;
  readonly promptSettled: boolean;
  readonly sessionSettled: boolean;
  readonly outputs: readonly MarketplaceOutput[];
  readonly sessionUpdates: readonly CommandRunResult["sessionUpdates"][number][];
  readonly configUpdates: readonly CommandRunResult["configUpdates"][number][];
}

export interface MarketplacePort {
  run(request: MarketplaceRequest, options?: PortCallOptions): Promise<MarketplaceResult>;
  capability: I2CapabilityKey;
}

function invalid(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

function token(value: string, label: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("-") ||
    trimmed.length > 256 ||
    /\s/.test(trimmed) ||
    sanitizeCatalogText(trimmed, 256) !== trimmed
  ) {
    throw invalid(`${label} must be a non-empty command name without whitespace.`);
  }
  return trimmed;
}

function pluginTarget(name: string, marketplace: string | undefined): string {
  const normalizedName = token(name, "Plugin name");
  if (normalizedName.includes("@") && marketplace !== undefined) {
    throw invalid("Plugin name must not include a marketplace when marketplace is supplied.");
  }
  return token(
    marketplace === undefined
      ? normalizedName
      : `${normalizedName}@${token(marketplace, "Marketplace")}`,
    "Plugin target",
  );
}

function commandFor(request: MarketplaceRequest): string {
  switch (request.operation) {
    case "add":
      return `/marketplace add ${token(request.source, "Marketplace source")}`;
    case "discover":
      return `/marketplace discover${request.marketplace === undefined ? "" : ` ${token(request.marketplace, "Marketplace")}`}`;
    case "help":
      return "/marketplace help";
    case "install":
      return `/marketplace install ${pluginTarget(request.name, request.marketplace)}`;
    case "installed":
      return "/marketplace installed";
    case "list":
      return "/marketplace list";
    case "remove":
      return `/marketplace remove ${token(request.marketplace, "Marketplace")}`;
    case "uninstall":
      return `/marketplace uninstall ${pluginTarget(request.name, request.marketplace)}`;
    case "update":
      return `/marketplace update${request.marketplace === undefined ? "" : ` ${token(request.marketplace, "Marketplace")}`}`;
    case "upgrade":
      return `/marketplace upgrade${request.name === undefined ? "" : ` ${pluginTarget(request.name, request.marketplace)}`}`;
    case "plugins-list":
      return "/plugins list";
    case "plugins-enable":
    case "plugins-disable": {
      const scope = request.scope === undefined ? "" : ` --scope ${request.scope}`;
      return `/plugins ${request.operation === "plugins-enable" ? "enable" : "disable"} ${pluginTarget(request.name, request.marketplace)}${scope}`;
    }
    case "reload-plugins":
      return "/reload-plugins";
  }
}

function safeOutputText(value: string): string | undefined {
  const redacted = value
    .replace(URL_CREDENTIALS, "$1<redacted>@")
    .replace(QUERY_CREDENTIALS, "$1<redacted>")
    .replace(BEARER_CREDENTIALS, "Bearer <redacted>");
  return sanitizeCatalogText(redacted, MAX_OUTPUT_TEXT);
}

function safeResult(operation: MarketplaceOperation, result: CommandRunResult): MarketplaceResult {
  const outputs = result.outputs.slice(0, MAX_OUTPUTS).flatMap((output) => {
    const text = safeOutputText(output.text);
    return text === undefined
      ? []
      : [{ text, ...(output.emittedAt === undefined ? {} : { emittedAt: output.emittedAt }) }];
  });
  const sessionUpdates = result.sessionUpdates.slice(0, MAX_UPDATES).map((update) =>
    Object.freeze({
      ...update,
      ...(update.title === undefined ? {} : { title: sanitizeCatalogText(update.title, 512) }),
    }),
  );
  const configUpdates = result.configUpdates.slice(0, MAX_UPDATES);
  return Object.freeze({
    operation,
    status: result.status,
    agentInvoked: result.agentInvoked,
    promptSettled: result.promptSettled,
    sessionSettled: result.sessionSettled,
    outputs: Object.freeze(outputs),
    sessionUpdates: Object.freeze(sessionUpdates),
    configUpdates: Object.freeze(configUpdates),
  });
}

function gatewayFailure(error: unknown): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure({
    code: "unavailable",
    message: "The marketplace command gateway is unavailable.",
    retryable: true,
    capability: I2CapabilityKeys.commandGateway,
  });
}

/** Executes only explicit, v18.6.1 RPC marketplace/plugin commands through A1.8. */
export function createMarketplacePort(client: AppClient): MarketplacePort {
  const gateway = client.port(OmpCommandGatewayPort);
  return Object.freeze({
    capability: I2CapabilityKeys.commandGateway,
    async run(request: MarketplaceRequest, options?: PortCallOptions) {
      const command = commandFor(request);
      try {
        const result = await gateway.run({ threadId: request.threadId, command }, options);
        return safeResult(request.operation, result);
      } catch (error) {
        throw gatewayFailure(error);
      }
    },
  });
}
