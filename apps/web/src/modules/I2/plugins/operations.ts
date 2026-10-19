import {
  AppFailure,
  type CapabilityMap,
  type ExtensionCatalogChanged,
  type FolderPath,
  type ThreadId,
  UiRequestId,
} from "@omp-app/contracts";
import type { DialogHost, DialogHostOpenOptions } from "@/modules/U4/contract";
import {
  capabilityFailure,
  type ExtensionCatalog,
  type ExtensionCatalogSnapshot,
  I2CapabilityKeys,
  isI2CapabilityAvailable,
  sanitizeCatalogText,
} from "../catalog/contract";
import type {
  MarketplacePort,
  MarketplaceRequest,
  MarketplaceResult,
} from "../catalog/marketplace";

export interface PluginOperationsOptions {
  readonly threadId: ThreadId;
  readonly folder: FolderPath | null;
  readonly capabilities: CapabilityMap;
  readonly dialogs?: Pick<DialogHost, "open" | "confirm">;
  readonly catalog: ExtensionCatalog;
  readonly marketplace: MarketplacePort;
}

export interface PluginToggleRequest {
  readonly name: string;
  readonly marketplace: string;
  readonly scope: "user" | "project";
  readonly enabled: boolean;
}

export interface PluginToggleHooks {
  readonly confirm: (title: string, message: string, signal?: AbortSignal) => Promise<boolean>;
  readonly signal?: AbortSignal;
}

export interface PluginOperations {
  readonly list: (signal?: AbortSignal) => Promise<MarketplaceResult>;
  readonly enable: (signal?: AbortSignal) => Promise<MarketplaceResult | null>;
  readonly disable: (signal?: AbortSignal) => Promise<MarketplaceResult | null>;
  readonly setEnabled: (
    request: PluginToggleRequest,
    hooks: PluginToggleHooks,
  ) => Promise<MarketplaceResult | null>;
  readonly uninstall: (signal?: AbortSignal) => Promise<MarketplaceResult | null>;
  readonly upgrade: (signal?: AbortSignal) => Promise<MarketplaceResult | null>;
  readonly reload: (signal?: AbortSignal) => Promise<ExtensionCatalogSnapshot>;
  readonly subscribeCatalogChanges: (
    listener: (change: ExtensionCatalogChanged) => void,
  ) => Promise<() => Promise<void>>;
}

let sequence = 0;

function requestId(purpose: string): UiRequestId {
  sequence += 1;
  return UiRequestId.parse(`app-i2-plugin-${purpose}-${sequence}`);
}

function dialogOptions(threadId: ThreadId, signal?: AbortSignal): DialogHostOpenOptions {
  return { threadId, origin: "app", signal };
}

function requireCapability(
  capabilities: CapabilityMap,
  key: typeof I2CapabilityKeys.commandGateway | typeof I2CapabilityKeys.extensionCatalog,
  action: string,
): void {
  if (isI2CapabilityAvailable(capabilities, key)) return;
  throw new AppFailure(capabilityFailure(key, action));
}

async function askText(
  dialogs: Pick<DialogHost, "open">,
  threadId: ThreadId,
  title: string,
  placeholder: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await dialogs.open(
    { kind: "input", id: requestId("input"), title, placeholder },
    dialogOptions(threadId, signal),
  );
  if (result.outcome !== "answered") return null;
  return sanitizeCatalogText(result.response.value, 256) ?? null;
}

export function createPluginOperations(options: PluginOperationsOptions): PluginOperations {
  const requireDialogs = (): Pick<DialogHost, "open" | "confirm"> => {
    if (options.dialogs !== undefined) return options.dialogs;
    throw new AppFailure({
      code: "unavailable",
      message: "Plugin dialogs are unavailable from this surface.",
      retryable: false,
    });
  };
  const askPluginTarget = async (
    signal?: AbortSignal,
  ): Promise<{ readonly name: string; readonly marketplace: string } | null> => {
    const value = await askText(
      requireDialogs(),
      options.threadId,
      "Plugin id",
      "name@marketplace",
      signal,
    );
    if (value === null) return null;
    const separator = value.lastIndexOf("@");
    const name = sanitizeCatalogText(value.slice(0, separator), 256);
    const marketplace = sanitizeCatalogText(value.slice(separator + 1), 256);
    if (separator <= 0 || name === undefined || marketplace === undefined) {
      throw new AppFailure({
        code: "invalid_args",
        message: "Enter the full plugin id as name@marketplace.",
        retryable: false,
      });
    }
    return { name, marketplace };
  };

  const scopeFor = async (signal?: AbortSignal): Promise<"user" | "project" | null> => {
    const selected = await requireDialogs().open(
      {
        kind: "select",
        id: requestId("plugin-scope"),
        title: "Choose where the plugin is installed",
        options: ["User plugins", "Project plugins"],
        optionDetails: [
          { description: "Ask omp to use the user installation." },
          { description: "Ask omp to use the project installation." },
        ],
      },
      dialogOptions(options.threadId, signal),
    );
    if (selected.outcome !== "answered" || selected.response.kind !== "select") return null;
    if (selected.response.value === "User plugins") return "user";
    if (selected.response.value === "Project plugins") return "project";
    return null;
  };

  const confirm = (title: string, message: string, signal?: AbortSignal) =>
    requireDialogs().confirm(
      { kind: "confirm", id: requestId("confirm-plugin"), title, message },
      dialogOptions(options.threadId, signal),
    );
  const report = async (
    title: string,
    result: MarketplaceResult,
    signal?: AbortSignal,
  ): Promise<void> => {
    const text = result.outputs.map((output) => output.text).join("\n\n");
    await requireDialogs().open(
      {
        kind: "editor",
        id: requestId("report"),
        title,
        prefill: text || "The operation returned no details.",
        readOnly: true,
      },
      dialogOptions(options.threadId, signal),
    );
  };

  const setEnabledWithDialog = async (
    target: {
      readonly name: string;
      readonly marketplace: string;
      readonly scope: "user" | "project";
    },
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<MarketplaceResult | null> => {
    requireCapability(options.capabilities, I2CapabilityKeys.commandGateway, "Plugin operations");
    const verb = enabled ? "Enable" : "Disable";
    if (
      !(await confirm(
        `${verb} plugin`,
        `${verb} the ${target.name} plugin in the ${target.scope} scope?`,
        signal,
      ))
    )
      return null;
    return options.marketplace.run(
      {
        operation: enabled ? "plugins-enable" : "plugins-disable",
        threadId: options.threadId,
        name: target.name,
        marketplace: target.marketplace,
        scope: target.scope,
      },
      { signal },
    );
  };

  const setEnabled = async (
    request: PluginToggleRequest,
    hooks: PluginToggleHooks,
  ): Promise<MarketplaceResult | null> => {
    requireCapability(options.capabilities, I2CapabilityKeys.commandGateway, "Plugin operations");
    const verb = request.enabled ? "Enable" : "Disable";
    if (
      !(await hooks.confirm(
        `${verb} plugin`,
        `${verb} the ${request.name} plugin in the ${request.scope} scope?`,
        hooks.signal,
      ))
    )
      return null;
    const result = await options.marketplace.run(
      {
        operation: request.enabled ? "plugins-enable" : "plugins-disable",
        threadId: options.threadId,
        name: request.name,
        marketplace: request.marketplace,
        scope: request.scope,
      },
      { signal: hooks.signal },
    );
    if (result.failure !== undefined) {
      throw new AppFailure({
        code: "omp_error",
        message: result.failure.message,
        retryable: false,
      });
    }
    return result;
  };

  const mutate = async (
    operation: "plugins-enable" | "plugins-disable" | "uninstall" | "upgrade",
    signal?: AbortSignal,
  ): Promise<MarketplaceResult | null> => {
    requireCapability(options.capabilities, I2CapabilityKeys.commandGateway, "Plugin operations");
    const target = await askPluginTarget(signal);
    if (target === null) return null;
    const scope = await scopeFor(signal);
    if (scope === null) return null;
    const verb =
      operation === "plugins-enable"
        ? "Enable"
        : operation === "plugins-disable"
          ? "Disable"
          : operation === "uninstall"
            ? "Uninstall"
            : "Upgrade";
    const result =
      operation === "plugins-enable" || operation === "plugins-disable"
        ? await setEnabledWithDialog({ ...target, scope }, operation === "plugins-enable", signal)
        : await (async () => {
            if (
              !(await confirm(
                `${verb} plugin`,
                `${verb} the ${target.name} plugin in the ${scope} scope?`,
                signal,
              ))
            )
              return null;
            const request: MarketplaceRequest =
              operation === "uninstall"
                ? {
                    operation,
                    threadId: options.threadId,
                    name: target.name,
                    marketplace: target.marketplace,
                    scope,
                  }
                : {
                    operation,
                    threadId: options.threadId,
                    name: target.name,
                    marketplace: target.marketplace,
                    scope,
                  };
            return options.marketplace.run(request, { signal });
          })();
    if (result === null) return null;
    await report(`${verb} plugin result`, result, signal);
    if (result.failure !== undefined) {
      throw new AppFailure({
        code: "omp_error",
        message: result.failure.message,
        retryable: false,
      });
    }
    return result;
  };

  const operations: PluginOperations = {
    async list(signal) {
      requireCapability(options.capabilities, I2CapabilityKeys.commandGateway, "Plugin list");
      return options.marketplace.run(
        { operation: "plugins-list", threadId: options.threadId },
        { signal },
      );
    },
    enable: (signal) => mutate("plugins-enable", signal),
    setEnabled,
    disable: (signal) => mutate("plugins-disable", signal),
    uninstall: (signal) => mutate("uninstall", signal),
    upgrade: (signal) => mutate("upgrade", signal),
    async reload(signal) {
      requireCapability(options.capabilities, I2CapabilityKeys.extensionCatalog, "Plugin reload");
      return options.catalog.reload(options.folder, { signal });
    },
    async subscribeCatalogChanges(listener) {
      requireCapability(
        options.capabilities,
        I2CapabilityKeys.extensionCatalog,
        "Catalog change notifications",
      );
      return options.catalog.subscribe(listener);
    },
  };
  return Object.freeze(operations);
}
