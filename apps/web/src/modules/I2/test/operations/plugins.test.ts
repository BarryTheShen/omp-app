import type { ExtensionCatalogChanged, ExtensionSummary } from "@omp-app/contracts";
import { AppFailure, CapabilityMap, FolderPath, Revision, ThreadId } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type {
  DialogHost,
  DialogHostOpenOptions,
  DialogRequest,
  DialogResponse,
  DialogResult,
  DialogResultFor,
} from "@/modules/U4/contract";
import type { ExtensionCatalog, ExtensionCatalogSnapshot } from "../../catalog/contract";
import { I2CapabilityKeys } from "../../catalog/contract";
import type {
  MarketplacePort,
  MarketplaceRequest,
  MarketplaceResult,
} from "../../catalog/marketplace";
import { createPluginOperations } from "../../plugins/operations";

const THREAD = ThreadId.parse("thread-i2-plugin-operations");
const FOLDER = FolderPath.parse("/workspace/project");
const READY = { state: "available", via: "host" } as const;

const PLUGIN: ExtensionSummary = {
  id: "example-plugin",
  name: "example-plugin",
  provider: "omp-plugins",
  source: "plugin",
  enabled: false,
  shadowed: false,
  capabilities: ["commands"],
  path: "plugins/example-plugin",
};

function snapshot(extensions: readonly ExtensionSummary[] = [PLUGIN]): ExtensionCatalogSnapshot {
  return {
    revision: Revision.parse("revision-1"),
    extensions,
    skills: [],
    prompts: [],
    sources: [],
    truncated: false,
  };
}

class ScriptedDialogs implements DialogHost {
  readonly requests: DialogRequest[] = [];
  readonly openOptions: DialogHostOpenOptions[] = [];
  readonly confirmations: Array<Extract<DialogRequest, { kind: "confirm" }>> = [];
  readonly answers: DialogResult[];
  readonly confirmAnswers: boolean[];

  constructor(answers: readonly DialogResult[] = [], confirmAnswers: readonly boolean[] = []) {
    this.answers = [...answers];
    this.confirmAnswers = [...confirmAnswers];
  }

  open<R extends DialogRequest>(
    request: R,
    options: DialogHostOpenOptions,
  ): Promise<DialogResultFor<R>> {
    this.requests.push(request);
    this.openOptions.push(options);
    const result = this.answers.shift();
    if (result === undefined) return Promise.reject(new Error("No dialog answer was scripted."));
    return Promise.resolve(result as DialogResultFor<R>);
  }

  confirm(
    request: Extract<DialogRequest, { kind: "confirm" }>,
    _options: DialogHostOpenOptions,
  ): Promise<boolean> {
    this.confirmations.push(request);
    return Promise.resolve(this.confirmAnswers.shift() ?? false);
  }
}

function answered(response: DialogResponse): DialogResult {
  return { outcome: "answered", response };
}

function setup(options: {
  readonly dialogs?: ScriptedDialogs;
  readonly extensions?: readonly ExtensionSummary[];
  readonly gatewayAvailable?: boolean;
  readonly catalogAvailable?: boolean;
  readonly run?: (request: MarketplaceRequest) => Promise<MarketplaceResult>;
  readonly onCatalogChange?: (listener: (change: ExtensionCatalogChanged) => void) => void;
}) {
  const dialogs = options.dialogs ?? new ScriptedDialogs();
  const requests: MarketplaceRequest[] = [];
  const reload = vi.fn(async () => snapshot(options.extensions));
  const list = vi.fn(async () => snapshot(options.extensions));
  const subscribe = vi.fn(async (listener: (change: ExtensionCatalogChanged) => void) => {
    options.onCatalogChange?.(listener);
    return async () => {};
  });
  const catalog: ExtensionCatalog = { list, reload, subscribe };
  const marketplace: MarketplacePort = {
    capability: I2CapabilityKeys.commandGateway,
    async run(request) {
      requests.push(request);
      return (
        (await options.run?.(request)) ?? {
          operation: request.operation,
          status: "completed",
          agentInvoked: true,
          promptSettled: true,
          sessionSettled: true,
          outputs: [],
          sessionUpdates: [],
          configUpdates: [],
        }
      );
    },
  };
  const operations = createPluginOperations({
    threadId: THREAD,
    folder: FOLDER,
    capabilities: CapabilityMap.parse({
      [I2CapabilityKeys.extensionCatalog]:
        options.catalogAvailable === false ? { state: "unavailable", via: "host" } : READY,
      [I2CapabilityKeys.commandGateway]:
        options.gatewayAvailable === false ? { state: "unavailable", via: "host" } : READY,
    }),
    dialogs,
    catalog,
    marketplace,
  });
  return { operations, dialogs, requests, list, reload, subscribe };
}

describe("I2 installed plugin operations", () => {
  test("lists installed plugin reports through the typed gateway without parsing omp text", async () => {
    const { operations, requests } = setup({});

    await operations.list();

    expect(requests).toEqual([{ operation: "plugins-list", threadId: THREAD }]);
  });

  test("setEnabled asks through hooks and does nothing when the answer is no", async () => {
    const { operations, requests } = setup({
      dialogs: {
        open: () => {
          throw new Error("setEnabled must not open dialogs");
        },
        confirm: () => {
          throw new Error("setEnabled must not use DialogHost.confirm");
        },
      } as never,
    });
    const confirm = vi.fn(async () => false);
    const result = await operations.setEnabled(
      { name: "example-plugin", marketplace: "community", scope: "user", enabled: true },
      { confirm },
    );
    expect(result).toBeNull();
    expect(confirm).toHaveBeenCalledWith(
      "Enable plugin",
      "Enable the example-plugin plugin in the user scope?",
      undefined,
    );
    expect(requests).toEqual([]);
  });

  test("setEnabled sends the typed request and turns omp failures into AppFailure", async () => {
    const refusal = 'Plugin "example-plugin@community" is not installed';
    const { operations, requests } = setup({
      dialogs: {
        open: () => {
          throw new Error("setEnabled must not open dialogs");
        },
        confirm: () => {
          throw new Error("setEnabled must not use DialogHost.confirm");
        },
      } as never,
      run: async () => ({
        operation: "plugins-disable",
        status: "completed",
        agentInvoked: true,
        promptSettled: true,
        sessionSettled: true,
        failure: { message: refusal },
        outputs: [{ text: refusal }],
        sessionUpdates: [],
        configUpdates: [],
      }),
    });
    await expect(
      operations.setEnabled(
        { name: "example-plugin", marketplace: "community", scope: "project", enabled: false },
        { confirm: async () => true },
      ),
    ).rejects.toMatchObject({ appError: { code: "omp_error", message: refusal } });
    expect(requests).toEqual([
      {
        operation: "plugins-disable",
        threadId: THREAD,
        name: "example-plugin",
        marketplace: "community",
        scope: "project",
      },
    ]);
  });

  test("requires a full plugin id, shows installed scopes, confirms, and sends a typed command", async () => {
    const dialogs = new ScriptedDialogs(
      [
        answered({ kind: "input", value: "example-plugin@community" }),
        answered({ kind: "select", value: "Project plugins" }),
        { outcome: "cancelled", kind: "editor", timedOut: false },
      ],
      [true],
    );
    const { operations, requests } = setup({ dialogs });

    await operations.enable();

    expect(dialogs.requests[1]).toMatchObject({
      kind: "select",
      title: "Choose where the plugin is installed",
      options: ["User plugins", "Project plugins"],
    });
    expect(dialogs.confirmations[0]?.message).toBe(
      "Enable the example-plugin plugin in the project scope?",
    );
    expect(requests).toEqual([
      {
        operation: "plugins-enable",
        threadId: THREAD,
        name: "example-plugin",
        marketplace: "community",
        scope: "project",
      },
    ]);
    expect(dialogs.openOptions.every((entry) => entry.origin === "app")).toBe(true);
  });

  test("shows omp's both-scope refusal as a failure report", async () => {
    const refusal =
      'Plugin "example-plugin@community" is installed in both user and project scope. Use --scope user or --scope project.';
    const dialogs = new ScriptedDialogs(
      [
        answered({ kind: "input", value: "example-plugin@community" }),
        answered({ kind: "select", value: "User plugins" }),
        { outcome: "cancelled", kind: "editor", timedOut: false },
      ],
      [true],
    );
    const { operations } = setup({
      dialogs,
      run: async (request) => ({
        operation: request.operation,
        status: "completed",
        agentInvoked: true,
        promptSettled: true,
        sessionSettled: true,
        failure: { message: refusal },
        outputs: [{ text: refusal }],
        sessionUpdates: [],
        configUpdates: [],
      }),
    });

    await expect(operations.upgrade()).rejects.toMatchObject({
      appError: { code: "omp_error", message: refusal },
    });
    expect(dialogs.requests.at(-1)).toMatchObject({
      kind: "editor",
      title: "Upgrade plugin result",
      prefill: refusal,
      readOnly: true,
    });
  });

  test("rejects an invalid plugin id before asking for scope", async () => {
    const dialogs = new ScriptedDialogs([answered({ kind: "input", value: "name-only" })]);
    const { operations, requests } = setup({ dialogs });

    await expect(operations.enable()).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    expect(dialogs.requests).toHaveLength(1);
    expect(requests).toEqual([]);
  });

  test("requires the command capability before opening a plugin dialog", async () => {
    const dialogs = new ScriptedDialogs();
    const { operations, requests } = setup({ dialogs, gatewayAvailable: false });

    await expect(operations.enable()).rejects.toMatchObject({
      appError: { code: "unavailable", capability: I2CapabilityKeys.commandGateway },
    });
    expect(dialogs.requests).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("a denied uninstall confirmation sends no gateway command", async () => {
    const dialogs = new ScriptedDialogs(
      [
        answered({ kind: "input", value: "example-plugin@community" }),
        answered({ kind: "select", value: "Project plugins" }),
      ],
      [false],
    );
    const { operations, requests } = setup({ dialogs });

    await expect(operations.uninstall()).resolves.toBeNull();
    expect(dialogs.confirmations).toHaveLength(1);
    expect(requests).toEqual([]);
  });
  test("preserves typed gateway timeouts and conflicts", async () => {
    for (const code of ["timeout", "conflict"] as const) {
      const failure = new AppFailure({
        code,
        message: `The marketplace command ${code}ed.`,
        retryable: code === "timeout",
      });
      const { operations } = setup({ run: async () => Promise.reject(failure) });

      await expect(operations.list()).rejects.toBe(failure);
    }
  });

  test("reload invokes A1.13 and the change listener is subscribed through the typed catalog port", async () => {
    const listeners: Array<(change: ExtensionCatalogChanged) => void> = [];
    const { operations, requests, reload, subscribe } = setup({
      onCatalogChange: (listener) => listeners.push(listener),
    });
    const changes: ExtensionCatalogChanged[] = [];

    await operations.reload();
    const unsubscribe = await operations.subscribeCatalogChanges((change) => changes.push(change));
    listeners[0]?.({ revision: Revision.parse("revision-2"), reason: "reload" });
    await unsubscribe();

    expect(reload).toHaveBeenCalledWith(FOLDER, { signal: undefined });
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([{ revision: "revision-2", reason: "reload" }]);
    expect(requests).toEqual([]);
  });
});
