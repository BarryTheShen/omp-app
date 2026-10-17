import { AppFailure, type CapabilityMap, type ThreadId, UiRequestId } from "@omp-app/contracts";
import type { DialogHost, DialogHostOpenOptions } from "@/modules/U4/contract";
import { capabilityFailure, I2CapabilityKeys, isI2CapabilityAvailable } from "../catalog/contract";
import type {
  MarketplacePort,
  MarketplaceRequest,
  MarketplaceResult,
} from "../catalog/marketplace";

export interface MarketplaceOperationsOptions {
  readonly threadId: ThreadId;
  readonly capabilities: CapabilityMap;
  readonly dialogs: Pick<DialogHost, "open" | "confirm">;
  readonly marketplace: MarketplacePort;
}

export interface MarketplaceOperations {
  readonly add: (signal?: AbortSignal) => Promise<MarketplaceResult | null>;
  readonly discover: (signal?: AbortSignal) => Promise<MarketplaceResult | null>;
  readonly help: (signal?: AbortSignal) => Promise<MarketplaceResult>;
  readonly installed: (signal?: AbortSignal) => Promise<MarketplaceResult>;
  readonly list: (signal?: AbortSignal) => Promise<MarketplaceResult>;
  readonly install: (signal?: AbortSignal) => Promise<MarketplaceResult | null>;
  readonly remove: (signal?: AbortSignal) => Promise<MarketplaceResult | null>;
  readonly uninstall: (signal?: AbortSignal) => Promise<MarketplaceResult | null>;
  readonly update: (signal?: AbortSignal) => Promise<MarketplaceResult | null>;
  readonly upgrade: (signal?: AbortSignal) => Promise<MarketplaceResult | null>;
  readonly report: (
    title: string,
    result: MarketplaceResult,
    signal?: AbortSignal,
  ) => Promise<void>;
}

let requestSequence = 0;

function dialogId(purpose: string): UiRequestId {
  requestSequence += 1;
  return UiRequestId.parse(`app-i2-marketplace-${purpose}-${requestSequence}`);
}

function dialogOptions(threadId: ThreadId, signal?: AbortSignal): DialogHostOpenOptions {
  return { threadId, origin: "app", signal };
}

function requireGateway(capabilities: CapabilityMap): void {
  if (isI2CapabilityAvailable(capabilities, I2CapabilityKeys.commandGateway)) return;
  throw new AppFailure(capabilityFailure(I2CapabilityKeys.commandGateway, "Marketplace commands"));
}

async function askText(
  dialogs: Pick<DialogHost, "open">,
  threadId: ThreadId,
  title: string,
  placeholder: string,
  signal?: AbortSignal,
  optional = false,
): Promise<string | null> {
  const result = await dialogs.open(
    {
      kind: "input",
      id: dialogId("input"),
      title,
      placeholder,
      optional,
    },
    dialogOptions(threadId, signal),
  );
  if (result.outcome !== "answered") return null;
  return result.response.value.trim();
}

async function askPluginTarget(
  dialogs: Pick<DialogHost, "open">,
  threadId: ThreadId,
  action: string,
  signal?: AbortSignal,
): Promise<{ readonly name: string; readonly marketplace: string } | null> {
  const target = await askText(dialogs, threadId, `${action} plugin`, "name@marketplace", signal);
  if (!target) return null;
  const separator = target.lastIndexOf("@");
  const name = target.slice(0, separator).trim();
  const marketplace = target.slice(separator + 1).trim();
  if (separator <= 0 || separator === target.length - 1 || !name || !marketplace) {
    throw new AppFailure({
      code: "invalid_args",
      message: "Enter the full plugin id as name@marketplace.",
      retryable: false,
    });
  }
  return { name, marketplace };
}
async function askUpgradeTarget(
  dialogs: Pick<DialogHost, "open">,
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<{ readonly name?: string; readonly marketplace?: string } | null> {
  const value = await askText(
    dialogs,
    threadId,
    "Upgrade marketplace plugins",
    "name@marketplace, or leave blank to upgrade all",
    signal,
    true,
  );
  if (value === null) return null;
  if (value === "") return {};
  const separator = value.lastIndexOf("@");
  const name = value.slice(0, separator).trim();
  const marketplace = value.slice(separator + 1).trim();
  if (separator <= 0 || separator === value.length - 1 || !name || !marketplace) {
    throw new AppFailure({
      code: "invalid_args",
      message: "Enter the full plugin id as name@marketplace, or leave blank to upgrade all.",
      retryable: false,
    });
  }
  return { name, marketplace };
}
async function askScope(
  dialogs: Pick<DialogHost, "open">,
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<"user" | "project" | null> {
  const result = await dialogs.open(
    {
      kind: "select",
      id: dialogId("scope"),
      title: "Choose an installation scope",
      options: ["User plugins", "Project plugins"],
      optionDetails: [
        { description: "Use the user installation." },
        { description: "Use the project installation." },
      ],
    },
    dialogOptions(threadId, signal),
  );
  if (result.outcome !== "answered" || result.response.kind !== "select") return null;
  return result.response.value === "User plugins"
    ? "user"
    : result.response.value === "Project plugins"
      ? "project"
      : null;
}

async function confirm(
  dialogs: Pick<DialogHost, "confirm">,
  threadId: ThreadId,
  title: string,
  message: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return dialogs.confirm(
    { kind: "confirm", id: dialogId("confirm"), title, message },
    dialogOptions(threadId, signal),
  );
}
async function showResult(
  dialogs: Pick<DialogHost, "open">,
  threadId: ThreadId,
  title: string,
  result: MarketplaceResult,
  signal?: AbortSignal,
): Promise<void> {
  await dialogs.open(
    {
      kind: "editor",
      id: dialogId("report"),
      title,
      prefill:
        result.outputs.map((output) => output.text).join("\n\n") ||
        "The operation returned no details.",
      readOnly: true,
    },
    dialogOptions(threadId, signal),
  );
}

export function createMarketplaceOperations(
  options: MarketplaceOperationsOptions,
): MarketplaceOperations {
  const run = async (
    request: MarketplaceRequest,
    signal?: AbortSignal,
  ): Promise<MarketplaceResult> => {
    requireGateway(options.capabilities);
    const result = await options.marketplace.run(request, { signal });
    if (result.failure !== undefined) {
      await showResult(
        options.dialogs,
        options.threadId,
        "Marketplace command failed",
        result,
        signal,
      );
      throw new AppFailure({
        code: "omp_error",
        message: result.failure.message,
        retryable: false,
      });
    }
    return result;
  };

  const runReadOnly = (operation: "help" | "installed" | "list", signal?: AbortSignal) =>
    run({ operation, threadId: options.threadId }, signal);

  const runConfirmed = async (
    request: MarketplaceRequest,
    title: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<MarketplaceResult | null> => {
    requireGateway(options.capabilities);
    if (!(await confirm(options.dialogs, options.threadId, title, message, signal))) return null;
    return run(request, signal);
  };

  const operations: MarketplaceOperations = {
    async add(signal) {
      requireGateway(options.capabilities);
      const source = await askText(
        options.dialogs,
        options.threadId,
        "Add a marketplace",
        "Owner/repository or marketplace source",
        signal,
      );
      if (!source) return null;
      return runConfirmed(
        { operation: "add", threadId: options.threadId, source },
        "Add marketplace",
        "Add this marketplace source?",
        signal,
      );
    },
    async discover(signal) {
      requireGateway(options.capabilities);
      const marketplace = await askText(
        options.dialogs,
        options.threadId,
        "Discover marketplace plugins",
        "Marketplace name (optional search scope)",
        signal,
        true,
      );
      if (marketplace === null) return null;
      return run(
        {
          operation: "discover",
          threadId: options.threadId,
          ...(marketplace ? { marketplace } : {}),
        },
        signal,
      );
    },
    help: (signal) => runReadOnly("help", signal),
    installed: (signal) => runReadOnly("installed", signal),
    list: (signal) => runReadOnly("list", signal),
    async install(signal) {
      requireGateway(options.capabilities);
      const target = await askPluginTarget(options.dialogs, options.threadId, "Install", signal);
      if (target === null) return null;
      const scope = await askScope(options.dialogs, options.threadId, signal);
      if (scope === null) return null;
      return runConfirmed(
        { operation: "install", threadId: options.threadId, ...target, scope, force: true },
        "Install plugin",
        "Install or replace this plugin?",
        signal,
      );
    },
    async remove(signal) {
      requireGateway(options.capabilities);
      const marketplace = await askText(
        options.dialogs,
        options.threadId,
        "Remove a marketplace",
        "Marketplace name",
        signal,
      );
      if (!marketplace) return null;
      return runConfirmed(
        { operation: "remove", threadId: options.threadId, marketplace },
        "Remove marketplace",
        "Remove this marketplace source? Its plugins will no longer be available from it.",
        signal,
      );
    },
    async uninstall(signal) {
      requireGateway(options.capabilities);
      const target = await askPluginTarget(options.dialogs, options.threadId, "Uninstall", signal);
      if (target === null) return null;
      const scope = await askScope(options.dialogs, options.threadId, signal);
      if (scope === null) return null;
      return runConfirmed(
        { operation: "uninstall", threadId: options.threadId, ...target, scope },
        "Uninstall plugin",
        "Uninstall this named plugin?",
        signal,
      );
    },
    async update(signal) {
      requireGateway(options.capabilities);
      const marketplace = await askText(
        options.dialogs,
        options.threadId,
        "Update marketplaces",
        "Marketplace name, or leave blank to update all",
        signal,
        true,
      );
      if (marketplace === null) return null;
      return runConfirmed(
        {
          operation: "update",
          threadId: options.threadId,
          ...(marketplace ? { marketplace } : {}),
        },
        "Update marketplace catalogs",
        "Update the marketplace catalog list?",
        signal,
      );
    },
    async upgrade(signal) {
      requireGateway(options.capabilities);
      const target = await askUpgradeTarget(options.dialogs, options.threadId, signal);
      if (target === null) return null;
      if (target.name === undefined) {
        return runConfirmed(
          { operation: "upgrade", threadId: options.threadId },
          "Upgrade marketplace plugins",
          "Upgrade all marketplace plugins?",
          signal,
        );
      }
      const scope = await askScope(options.dialogs, options.threadId, signal);
      if (scope === null) return null;
      return runConfirmed(
        { operation: "upgrade", threadId: options.threadId, ...target, scope },
        "Upgrade marketplace plugins",
        "Upgrade this named plugin?",
        signal,
      );
    },
    async report(title, result, signal) {
      const text = result.outputs.map((output) => output.text).join("\n\n");
      await options.dialogs.open(
        {
          kind: "editor",
          id: dialogId("report"),
          title,
          prefill: text || "omp returned no text for this operation.",
          readOnly: true,
        },
        dialogOptions(options.threadId, signal),
      );
    },
  };
  return Object.freeze(operations);
}
