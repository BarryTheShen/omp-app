import type { AppClient, AppClientSubscription, SubscribeOptions } from "@omp-app/client";
import {
  AppFailure,
  type CommandRunResult,
  type ConfigChanged,
  ConfigEntry,
  type ConfigListArgs,
  type ConfigWriteArgs,
  type FolderPath,
  type JsonValue,
  OmpCommandGateway,
  ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import {
  ADVISOR_KEYS,
  type AdvisorCommand,
  type AdvisorConfigLayer,
  type AdvisorKey,
  advisorCommand,
  advisorEntryValue,
  advisorSource,
  createAdvisorCommandController,
  createAdvisorCommandSource,
  createAdvisorConfigController,
} from "./advisor";

// @ts-expect-error The advisor UI must not write settings to the app-only configuration layer.
const unsupportedAdvisorLayer: AdvisorConfigLayer = "app";
void unsupportedAdvisorLayer;

const threadId = ThreadId.parse("advisor-thread");
const folder = "/workspace/project" as FolderPath;
const result: CommandRunResult = {
  command: "/advisor",
  status: "completed",
  agentInvoked: false,
  promptSettled: true,
  sessionSettled: true,
  outputs: [],
  sessionUpdates: [],
  configUpdates: [],
};

interface FakeConfigHarness {
  readonly client: AppClient;
  readonly listCalls: ConfigListArgs[];
  readonly writeCalls: ConfigWriteArgs[];
  readonly subscribeScopes: Array<string | undefined>;
  readonly emitChange: (change: ConfigChanged) => void;
  readonly unsubscribeCount: () => number;
}

function fakeClient(options: {
  readonly commandRun?: (command: string) => Promise<CommandRunResult>;
  readonly list?: (args: ConfigListArgs) => Promise<{
    readonly entries: readonly ConfigEntry[];
    readonly revision: string;
  }>;
  readonly write?: (args: ConfigWriteArgs) => Promise<{
    readonly entry: ConfigEntry;
    readonly revision: string;
  }>;
}): FakeConfigHarness {
  const listCalls: ConfigListArgs[] = [];
  const writeCalls: ConfigWriteArgs[] = [];
  const subscribeScopes: Array<string | undefined> = [];
  const changeListeners = new Set<(change: ConfigChanged, seq: number) => void>();
  let unsubscribeCount = 0;
  const gateway = {
    run: async ({ command }: { readonly command: string }) =>
      options.commandRun?.(command) ?? result,
  };
  const config = {
    list: async (args: ConfigListArgs) => {
      listCalls.push(args);
      return options.list?.(args) ?? { entries: [], revision: "rev-1" };
    },
    write: async (args: ConfigWriteArgs) => {
      writeCalls.push(args);
      if (options.write) return options.write(args);
      if (args.value.secret) throw new Error("advisor settings are not secrets");
      return {
        entry: ConfigEntry.parse({
          key: args.key,
          secret: false,
          value: args.value.value,
          source: args.layer,
          overrides: [],
        }),
        revision: "rev-2",
      };
    },
  };
  const client = {
    connectionState: "open",
    instanceId: "instance-1",
    port: (port: unknown) => (port === OmpCommandGateway ? gateway : config),
    onConnectionState: () => () => undefined,
    onResync: () => () => undefined,
    subscribe: async (_port: unknown, _event: unknown, options?: SubscribeOptions) => {
      subscribeScopes.push(options?.scope);
      const subscription: AppClientSubscription<ConfigChanged> = {
        stream: "A1.configStore/changed/global" as never,
        lastSeq: 0,
        onEvent: (listener) => {
          changeListeners.add(listener);
          return () => changeListeners.delete(listener);
        },
        unsubscribe: async () => {
          unsubscribeCount += 1;
        },
      };
      return subscription;
    },
    dispose: () => undefined,
  } as unknown as AppClient;
  return {
    client,
    listCalls,
    writeCalls,
    subscribeScopes,
    emitChange: (change) => {
      for (const listener of changeListeners) listener(change, 1);
    },
    unsubscribeCount: () => unsubscribeCount,
  };
}

describe("advisor command handoff", () => {
  test("maps each typed command to omp's matching slash command", async () => {
    const commands: string[] = [];
    const harness = fakeClient({
      commandRun: async (command) => {
        commands.push(command);
        return result;
      },
    });
    const source = createAdvisorCommandSource(harness.client, threadId);
    const spellings = [
      ["toggle", "/advisor toggle"],
      ["on", "/advisor on"],
      ["off", "/advisor off"],
      ["status", "/advisor status"],
      ["dump", "/advisor dump"],
    ] as const satisfies readonly (readonly [AdvisorCommand, string])[];
    for (const [command, spelling] of spellings) {
      expect(advisorCommand(command)).toBe(spelling);
      await source.run(command);
    }
    expect(commands).toEqual(spellings.map(([, spelling]) => spelling));
  });

  test("ignores another command while a request is already in flight", async () => {
    const gate = Promise.withResolvers<CommandRunResult>();
    const commands: AdvisorCommand[] = [];
    const controller = createAdvisorCommandController({
      run: (command) => {
        commands.push(command);
        return gate.promise;
      },
    });
    const running = controller.run("toggle");
    await expect(controller.run("status")).resolves.toBeUndefined();
    expect(commands).toEqual(["toggle"]);
    gate.resolve(result);
    await expect(running).resolves.toBe(result);
  });
  test("releases the single-flight guard after a command resolves", async () => {
    const commands: AdvisorCommand[] = [];
    const controller = createAdvisorCommandController({
      run: async (command) => {
        commands.push(command);
        return { ...result, command: advisorCommand(command) };
      },
    });
    await expect(controller.run("toggle")).resolves.toMatchObject({ command: "/advisor toggle" });
    await expect(controller.run("status")).resolves.toMatchObject({ command: "/advisor status" });
    expect(commands).toEqual(["toggle", "status"]);
  });

  test("releases the single-flight guard after a command rejects", async () => {
    const failure = new AppFailure({
      code: "unavailable",
      message: "The command is unavailable.",
      retryable: false,
    });
    const commands: AdvisorCommand[] = [];
    let rejectFirst = true;
    const controller = createAdvisorCommandController({
      run: async (command) => {
        commands.push(command);
        if (rejectFirst) {
          rejectFirst = false;
          throw failure;
        }
        return { ...result, command: advisorCommand(command) };
      },
    });
    await expect(controller.run("toggle")).rejects.toBe(failure);
    await expect(controller.run("status")).resolves.toMatchObject({ command: "/advisor status" });
    expect(commands).toEqual(["toggle", "status"]);
  });

  test("reports a typed command failure while preserving it for the caller", async () => {
    const expected = new AppFailure({
      code: "unavailable",
      message: "The command is unavailable.",
      retryable: false,
    });
    const controller = createAdvisorCommandController({
      run: async () => {
        throw expected;
      },
    });
    await expect(controller.run("toggle")).rejects.toBe(expected);
    expect(controller.getSnapshot()).toMatchObject({ status: "error", error: expected });
  });
  test("a disposed command controller refuses another run", async () => {
    const controller = createAdvisorCommandController({ run: async () => result });
    controller.dispose();
    await expect(controller.run("status")).rejects.toMatchObject({
      appError: { code: "cancelled" },
    });
  });
});

describe("advisor configuration handoff", () => {
  test("reads global provenance and writes exactly one revisioned key to the requested layer", async () => {
    const entry = ConfigEntry.parse({
      key: "advisor.enabled",
      secret: false,
      value: true,
      source: "global",
      overrides: [],
    });
    const harness = fakeClient({
      list: async () => ({ entries: [entry], revision: "rev-7" }),
      write: async () => ({
        entry: ConfigEntry.parse({
          key: "advisor.enabled",
          secret: false,
          value: false,
          source: "global",
          overrides: [],
        }),
        revision: "rev-8",
      }),
    });
    const controller = createAdvisorConfigController(harness.client, { folder, layer: "global" });
    const state = await controller.read();
    expect(harness.listCalls[0]).toEqual({ prefix: "advisor", folder: null });
    expect(state.entries.map((item) => item.key)).toEqual(["advisor.enabled"]);
    expect(advisorEntryValue(state.entries[0])).toBe(true);
    expect(advisorSource(state.entries[0])).toBe("global");
    await controller.write("advisor.enabled", false);
    expect(harness.writeCalls[0]).toEqual({
      key: "advisor.enabled",
      layer: "global",
      folder: null,
      value: { secret: false, value: false },
      expectedRevision: "rev-7",
    });
    expect(controller.getSnapshot().revision).toBe("rev-8");
    expect(ADVISOR_KEYS).toHaveLength(7);
    controller.dispose();
  });

  test("writes project settings to the selected folder", async () => {
    const entry = ConfigEntry.parse({
      key: "advisor.reviewInterval",
      secret: false,
      value: 1,
      source: "project",
      overrides: [],
    });
    const harness = fakeClient({
      list: async () => ({ entries: [entry], revision: "rev-3" }),
      write: async (args) => ({
        entry: ConfigEntry.parse({
          key: args.key,
          secret: false,
          value: 5,
          source: "project",
          overrides: [],
        }),
        revision: "rev-4",
      }),
    });
    const controller = createAdvisorConfigController(harness.client, { folder, layer: "project" });
    await controller.read();
    await controller.write("advisor.reviewInterval", 5);
    expect(harness.listCalls[0]).toEqual({ prefix: "advisor", folder });
    expect(harness.writeCalls[0]).toEqual({
      key: "advisor.reviewInterval",
      layer: "project",
      folder,
      value: { secret: false, value: 5 },
      expectedRevision: "rev-3",
    });
    expect(controller.getSnapshot().revision).toBe("rev-4");
    controller.dispose();
  });

  test("refuses invalid values for every advisor setting before writing", async () => {
    const invalidValues: readonly (readonly [AdvisorKey, JsonValue])[] = [
      ["advisor.enabled", "yes"],
      ["advisor.syncBacklog", "sometimes"],
      ["advisor.syncBacklog", 3],
      ["advisor.immuneTurns", -1],
      ["advisor.reviewMode", "always"],
      ["advisor.reviewInterval", 0],
      ["advisor.maxNotesPerUpdate", 0],
      ["advisor.maxNotesPerUpdate", 1.5],
      ["advisor.evictStaleResults", "no"],
    ];
    const harness = fakeClient({});
    const controller = createAdvisorConfigController(harness.client, {
      folder: null,
      layer: "global",
    });
    for (const [key, value] of invalidValues) {
      await expect(controller.write(key, value)).rejects.toMatchObject({
        appError: { code: "invalid_args" },
      });
    }
    expect(harness.writeCalls).toEqual([]);
    controller.dispose();
  });
  test("accepts whole note counts above 32", async () => {
    const harness = fakeClient({});
    const controller = createAdvisorConfigController(harness.client, {
      folder: null,
      layer: "global",
    });
    await controller.write("advisor.maxNotesPerUpdate", 33);
    expect(harness.writeCalls).toHaveLength(1);
    expect(harness.writeCalls[0]).toMatchObject({
      key: "advisor.maxNotesPerUpdate",
      value: { secret: false, value: 33 },
    });
    controller.dispose();
  });

  test("refuses project settings when no workspace folder is available", () => {
    const harness = fakeClient({});
    expect(() =>
      createAdvisorConfigController(harness.client, {
        folder: null,
        layer: "project",
      }),
    ).toThrow("A workspace folder is needed for project advisor settings.");
    expect(harness.listCalls).toEqual([]);
    expect(harness.writeCalls).toEqual([]);
  });

  test("refuses the app-only config layer", () => {
    const harness = fakeClient({});
    expect(() =>
      createAdvisorConfigController(harness.client, {
        folder: null,
        layer: "app" as AdvisorConfigLayer,
      }),
    ).toThrow("Advisor settings can only be stored in the global or project layer.");
    expect(harness.listCalls).toEqual([]);
    expect(harness.writeCalls).toEqual([]);
  });

  test("refreshes on advisor changes and unsubscribes when disposed", async () => {
    let value = true;
    let revision = "rev-1";
    const entry = () =>
      ConfigEntry.parse({
        key: "advisor.enabled",
        secret: false,
        value,
        source: "global",
        overrides: [],
      });
    const harness = fakeClient({
      list: async () => ({ entries: [entry()], revision }),
    });
    const controller = createAdvisorConfigController(harness.client, { folder, layer: "global" });
    await controller.read();
    await vi.waitFor(() => expect(harness.subscribeScopes).toEqual([folder]));
    value = false;
    revision = "rev-2";
    const refreshedEntry = entry();
    harness.emitChange({
      key: "advisor.enabled",
      layer: "global",
      folder: null,
      revision,
      entry: refreshedEntry,
    });
    await vi.waitFor(() => expect(controller.getSnapshot().revision).toBe("rev-2"));
    expect(advisorEntryValue(controller.getSnapshot().entries[0])).toBe(false);

    controller.dispose();
    expect(harness.unsubscribeCount()).toBe(1);
    const callCount = harness.listCalls.length;
    value = true;
    revision = "rev-3";
    harness.emitChange({
      key: "advisor.enabled",
      layer: "global",
      folder: null,
      revision,
      entry: entry(),
    });
    await Promise.resolve();
    expect(harness.listCalls).toHaveLength(callCount);
  });

  test("keeps a revision conflict as a distinct recoverable state", async () => {
    const conflict = new AppFailure({
      code: "conflict",
      message: "This setting changed elsewhere.",
      retryable: true,
    });
    const controller = createAdvisorConfigController(
      fakeClient({
        write: async () => {
          throw conflict;
        },
      }).client,
      { folder: null, layer: "global" },
    );
    await controller.read();
    await expect(controller.write("advisor.enabled", true)).rejects.toBe(conflict);
    expect(controller.getSnapshot()).toMatchObject({ phase: "conflict", error: conflict });
    controller.dispose();
  });
});
