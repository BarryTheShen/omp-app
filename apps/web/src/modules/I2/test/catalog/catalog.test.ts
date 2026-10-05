import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityMap,
  type CommandRunResult,
  type ExtensionCatalogChanged,
  ExtensionCatalog as ExtensionCatalogPort,
  type ExtensionCatalogResult,
  FolderPath,
  OmpCommandGateway as OmpCommandGatewayPort,
  type PortClient,
  ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { createExtensionCatalog } from "../../catalog/catalog";
import {
  capabilityFailure,
  type ExtensionCatalog,
  isI2CapabilityAvailable,
  normalizeCatalog,
} from "../../catalog/contract";
import { createMarketplacePort, type MarketplacePort } from "../../catalog/marketplace";

const folder = FolderPath.parse("/workspace/project");
const threadId = ThreadId.parse("thread-i2");

function catalogResult(): ExtensionCatalogResult {
  return {
    revision: "revision-1",
    extensions: [
      {
        id: "demo-plugin",
        name: "demo-plugin",
        provider: "marketplace",
        source: "plugin",
        version: "1.0.0",
        enabled: true,
        shadowed: false,
        capabilities: ["tools", "tools", "\u0000hooks"],
        path: "plugins/demo-plugin",
        description: "<b>untrusted description</b>",
      },
      {
        id: "docs",
        name: "docs",
        provider: "native",
        source: "skill",
        enabled: false,
        shadowed: true,
        capabilities: ["skills"],
        path: "/host/private/docs",
        error: "metadata warning",
      },
    ],
    commands: [
      {
        name: "review",
        provider: "native",
        source: "skill",
        path: "commands/review.md",
        description: "Review prompt",
        enabled: true,
      },
    ],
  };
}

function commandResult(overrides: Partial<CommandRunResult> = {}): CommandRunResult {
  return {
    command: "/marketplace list",
    status: "completed",
    agentInvoked: false,
    promptSettled: true,
    sessionSettled: true,
    outputs: [{ text: "ok\u0000 output" }],
    sessionUpdates: [],
    configUpdates: [],
    ...overrides,
  };
}

function fakeClient(
  extensionPort: Partial<PortClient<typeof ExtensionCatalogPort>>,
  gatewayPort: Partial<PortClient<typeof OmpCommandGatewayPort>>,
  onSubscribe?: (listener: (change: ExtensionCatalogChanged) => void) => () => void,
): AppClient {
  const client = {
    port(port: unknown) {
      if (port === ExtensionCatalogPort) return extensionPort;
      if (port === OmpCommandGatewayPort) return gatewayPort;
      throw new Error("unexpected port");
    },
    subscribe: async () => {
      let listener: ((change: ExtensionCatalogChanged) => void) | undefined;
      const dispose = onSubscribe?.((change) => listener?.(change));
      return {
        stream: "A1.extensionCatalog/changed",
        lastSeq: 0,
        onEvent(next: (change: ExtensionCatalogChanged) => void) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        unsubscribe: async () => dispose?.(),
      };
    },
  };
  return client as unknown as AppClient;
}

describe("I2 safe extension catalog model", () => {
  test("separates installed extensions, skills and prompts while sanitizing metadata", () => {
    const snapshot = normalizeCatalog(catalogResult());

    expect(snapshot.extensions).toHaveLength(1);
    expect(snapshot.extensions[0]).toMatchObject({
      id: "demo-plugin",
      source: "plugin",
      path: "plugins/demo-plugin",
      description: "<b>untrusted description</b>",
      capabilities: ["tools", "hooks"],
    });
    expect(snapshot.skills).toHaveLength(1);
    expect(snapshot.skills[0]?.path).toBeUndefined();
    expect(snapshot.prompts).toMatchObject([{ name: "review", source: "skill", enabled: true }]);
    expect(snapshot.sources).toEqual([
      { source: "plugin", provider: "marketplace", total: 1, enabled: 1, shadowed: 0 },
      { source: "skill", provider: "native", total: 1, enabled: 0, shadowed: 1 },
    ]);
  });

  test("bounds catalog state and marks omitted rows instead of retaining unbounded arrays", () => {
    const result = catalogResult();
    const base = result.extensions[0];
    if (base === undefined) throw new Error("fixture is missing its base extension");
    result.extensions = Array.from({ length: 1_005 }, (_, index) => ({
      ...base,
      id: `extension-${index}`,
      name: `extension-${index}`,
    }));
    const snapshot = normalizeCatalog(result);
    expect(snapshot.extensions).toHaveLength(1_000);
    expect(snapshot.truncated).toBe(true);
  });
});

describe("I2 extension catalog adapter", () => {
  test("uses A0's typed client for list/reload and change subscriptions", async () => {
    const calls: string[] = [];
    let emit!: (change: ExtensionCatalogChanged) => void;
    const client = fakeClient(
      {
        list: async (args) => {
          calls.push(`list:${args.folder}`);
          return catalogResult();
        },
        reload: async (args) => {
          calls.push(`reload:${args.folder}`);
          return { ...catalogResult(), revision: "revision-2" };
        },
      },
      {},
      (listener) => {
        emit = listener;
        return () => calls.push("dispose");
      },
    );
    const adapter: ExtensionCatalog = createExtensionCatalog(client);
    const changes: ExtensionCatalogChanged[] = [];
    const stop = await adapter.subscribe((change) => changes.push(change));
    emit({ revision: "revision-2", reason: "reload" });

    expect((await adapter.list(folder)).revision).toBe("revision-1");
    expect((await adapter.reload(null)).revision).toBe("revision-2");
    expect(changes).toEqual([{ revision: "revision-2", reason: "reload" }]);
    await stop();
    expect(calls).toEqual([`list:${folder}`, "reload:null", "dispose"]);
  });

  test("preserves typed capability failures and maps transport failures safely", async () => {
    const typed = new AppFailure({
      code: "unavailable",
      message: "catalog unavailable",
      retryable: false,
      capability: "host.extension-catalog",
    });
    const typedAdapter = createExtensionCatalog(
      fakeClient({ list: async () => Promise.reject(typed) }, {}),
    );
    await expect(typedAdapter.list(null)).rejects.toBe(typed);

    const failedAdapter = createExtensionCatalog(
      fakeClient({ list: async () => Promise.reject(new Error("private path")) }, {}),
    );
    await expect(failedAdapter.list(null)).rejects.toMatchObject({
      appError: {
        code: "unavailable",
        message: "Extension catalog list is unavailable.",
        capability: "host.extension-catalog",
      },
    });
  });
});

describe("I2 marketplace command adapter", () => {
  test("builds only explicit marketplace/plugin commands and returns safe structured output", async () => {
    const commands: string[] = [];
    const client = fakeClient(
      {},
      {
        run: async (args) => {
          commands.push(args.command);
          return commandResult({ command: args.command });
        },
      },
    );
    const marketplace: MarketplacePort = createMarketplacePort(client);

    await marketplace.run({
      operation: "install",
      threadId,
      name: "demo",
      marketplace: "community",
    });
    await marketplace.run({
      operation: "plugins-disable",
      threadId,
      name: "demo",
      marketplace: "community",
      scope: "project",
    });
    const result = await marketplace.run({ operation: "reload-plugins", threadId });

    expect(commands).toEqual([
      "/marketplace install demo@community",
      "/plugins disable demo@community --scope project",
      "/reload-plugins",
    ]);
    expect(result.outputs).toEqual([{ text: "ok output" }]);
    expect(result.operation).toBe("reload-plugins");
  });

  test("rejects picker-style missing names before calling omp and maps gateway failures", async () => {
    let calls = 0;
    const client = fakeClient(
      {},
      {
        run: async () => {
          calls += 1;
          return commandResult();
        },
      },
    );
    const marketplace = createMarketplacePort(client);
    await expect(
      marketplace.run({ operation: "install", threadId, name: "   " }),
    ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
    await expect(
      marketplace.run({ operation: "install", threadId, name: "--help" }),
    ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
    expect(calls).toBe(0);

    const failing = createMarketplacePort(
      fakeClient({}, { run: async () => Promise.reject(new Error("secret command text")) }),
    );
    await expect(failing.run({ operation: "list", threadId })).rejects.toMatchObject({
      appError: {
        code: "unavailable",
        message: "The marketplace command gateway is unavailable.",
        capability: "host.command-gateway",
      },
    });
  });

  test("exposes capability gates for terminal-only skills and auth gateway paths", () => {
    const capabilities: CapabilityMap = {
      "host.extension-catalog": { state: "available", via: "host" },
      "host.command-gateway": { state: "available", via: "host" },
      "host.skills-registry": { state: "unavailable", via: "host" },
      "host.auth-gateway": { state: "unavailable", via: "host" },
    };
    expect(isI2CapabilityAvailable(capabilities, "host.command-gateway")).toBe(true);
    expect(isI2CapabilityAvailable(capabilities, "host.skills-registry")).toBe(false);
    expect(capabilityFailure("host.skills-registry", "Skills registry operations")).toMatchObject({
      code: "unavailable",
      capability: "host.skills-registry",
    });
  });
});
