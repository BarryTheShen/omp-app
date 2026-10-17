import { CapabilityMap, type CommandRunResult, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type {
  DialogHost,
  DialogHostOpenOptions,
  DialogRequest,
  DialogResponse,
  DialogResult,
  DialogResultFor,
} from "@/modules/U4/contract";
import { I2CapabilityKeys } from "../../catalog/contract";
import type {
  MarketplaceOperation,
  MarketplacePort,
  MarketplaceRequest,
  MarketplaceResult,
} from "../../catalog/marketplace";
import { createMarketplaceOperations } from "../../marketplace/operations";

const THREAD = ThreadId.parse("thread-i2-operations");
const READY = { state: "available", via: "host" } as const;

function commandResult(overrides: Partial<CommandRunResult> = {}): CommandRunResult {
  return {
    command: "/marketplace list",
    status: "completed",
    agentInvoked: true,
    promptSettled: true,
    sessionSettled: true,
    outputs: [{ text: "A marketplace report; do not parse this text." }],
    sessionUpdates: [],
    configUpdates: [],
    ...overrides,
  };
}

function marketplaceResult(
  operation: MarketplaceOperation,
  overrides: Partial<CommandRunResult> = {},
): MarketplaceResult {
  return { operation, ...commandResult(overrides) };
}

class ScriptedDialogs implements DialogHost {
  readonly requests: DialogRequest[] = [];
  readonly openOptions: DialogHostOpenOptions[] = [];
  readonly confirmations: Array<Extract<DialogRequest, { kind: "confirm" }>> = [];
  readonly confirmOptions: DialogHostOpenOptions[] = [];
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
    const response = this.answers.shift();
    if (response === undefined) return Promise.reject(new Error("No dialog answer was scripted."));
    return Promise.resolve(response as DialogResultFor<R>);
  }

  confirm(
    request: Extract<DialogRequest, { kind: "confirm" }>,
    options: DialogHostOpenOptions,
  ): Promise<boolean> {
    this.confirmations.push(request);
    this.confirmOptions.push(options);
    return Promise.resolve(this.confirmAnswers.shift() ?? false);
  }
}

function answered(response: DialogResponse): DialogResult {
  return { outcome: "answered", response };
}

function setup(
  dialogs: ScriptedDialogs,
  options: {
    gatewayAvailable?: boolean;
    run?: (request: MarketplaceRequest) => Promise<MarketplaceResult>;
  } = {},
) {
  const requests: MarketplaceRequest[] = [];
  const marketplace: MarketplacePort = {
    capability: I2CapabilityKeys.commandGateway,
    async run(request) {
      requests.push(request);
      return (await options.run?.(request)) ?? marketplaceResult(request.operation);
    },
  };
  const operations = createMarketplaceOperations({
    threadId: THREAD,
    capabilities: CapabilityMap.parse({
      [I2CapabilityKeys.commandGateway]:
        options.gatewayAvailable === false
          ? { state: "unavailable", via: "host", detail: "not connected" }
          : READY,
    }),
    dialogs,
    marketplace,
  });
  return { operations, requests };
}

describe("I2 marketplace operations", () => {
  test("an app-origin confirmation denies the gateway mutation when cancelled", async () => {
    const dialogs = new ScriptedDialogs(
      [answered({ kind: "input", value: "owner/repository" })],
      [false],
    );
    const { operations, requests } = setup(dialogs);

    expect(await operations.add()).toBeNull();
    expect(dialogs.confirmations).toHaveLength(1);
    expect(dialogs.confirmOptions[0]).toMatchObject({ threadId: THREAD, origin: "app" });
    expect(requests).toEqual([]);
  });

  test("confirms a named marketplace add and forwards its explicit source unchanged", async () => {
    const dialogs = new ScriptedDialogs(
      [answered({ kind: "input", value: "owner/repository" })],
      [true],
    );
    const { operations, requests } = setup(dialogs);

    await operations.add();

    expect(dialogs.confirmations[0]?.message).toBe("Add this marketplace source?");
    expect(requests).toEqual([{ operation: "add", threadId: THREAD, source: "owner/repository" }]);
  });

  test("requires confirmation for each marketplace mutation, including all-catalog actions", async () => {
    const cases: readonly {
      readonly method: "install" | "remove" | "uninstall" | "update" | "upgrade";
      readonly answers: readonly DialogResult[];
      readonly expected: MarketplaceRequest;
    }[] = [
      {
        method: "install",
        answers: [
          answered({ kind: "input", value: "name@market" }),
          answered({ kind: "select", value: "Project plugins" }),
        ],
        expected: {
          operation: "install",
          threadId: THREAD,
          name: "name",
          marketplace: "market",
          scope: "project",
          force: true,
        },
      },
      {
        method: "remove",
        answers: [answered({ kind: "input", value: "market" })],
        expected: { operation: "remove", threadId: THREAD, marketplace: "market" },
      },
      {
        method: "uninstall",
        answers: [
          answered({ kind: "input", value: "name@market" }),
          answered({ kind: "select", value: "User plugins" }),
        ],
        expected: {
          operation: "uninstall",
          threadId: THREAD,
          name: "name",
          marketplace: "market",
          scope: "user",
        },
      },
      {
        method: "update",
        answers: [answered({ kind: "input", value: "" })],
        expected: { operation: "update", threadId: THREAD },
      },
      {
        method: "upgrade",
        answers: [
          answered({ kind: "input", value: "name@market" }),
          answered({ kind: "select", value: "User plugins" }),
        ],
        expected: {
          operation: "upgrade",
          threadId: THREAD,
          name: "name",
          marketplace: "market",
          scope: "user",
        },
      },
      {
        method: "upgrade",
        answers: [answered({ kind: "input", value: "" })],
        expected: { operation: "upgrade", threadId: THREAD },
      },
    ];
    for (const { method, answers, expected } of cases) {
      const dialogs = new ScriptedDialogs(answers, [true]);
      const { operations, requests } = setup(dialogs);
      await operations[method]();
      expect(dialogs.confirmations, method).toHaveLength(1);
      expect(requests, method).toEqual([expected]);
    }
  });
  test("rejects an invalid plugin id before confirming", async () => {
    const dialogs = new ScriptedDialogs([answered({ kind: "input", value: "name-only" })]);
    const { operations, requests } = setup(dialogs);

    await expect(operations.install()).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    expect(dialogs.confirmations).toHaveLength(0);
    expect(requests).toEqual([]);
  });

  test("shows omp's refusal as a failed report instead of a successful result", async () => {
    const refusal = 'Invalid plugin ID format: "name-only". Expected "name@marketplace".';
    const dialogs = new ScriptedDialogs(
      [
        answered({ kind: "input", value: "name@market" }),
        answered({ kind: "select", value: "User plugins" }),
        { outcome: "cancelled", kind: "editor", timedOut: false },
      ],
      [true],
    );
    const { operations } = setup(dialogs, {
      run: async (request) => ({
        ...marketplaceResult(request.operation),
        failure: { message: refusal },
        outputs: [{ text: refusal }],
      }),
    });

    await expect(operations.install()).rejects.toMatchObject({
      appError: { code: "omp_error", message: refusal },
    });
    expect(dialogs.requests.at(-1)).toMatchObject({
      kind: "editor",
      title: "Marketplace command failed",
      prefill: refusal,
    });
  });

  test("a blank discover scope remains an explicit unscoped request, without parsing its report", async () => {
    const dialogs = new ScriptedDialogs([
      answered({ kind: "input", value: "" }),
      { outcome: "cancelled", kind: "editor", timedOut: false },
    ]);
    const { operations, requests } = setup(dialogs);

    const result = await operations.discover();
    if (result === null) throw new Error("Expected discovery to return a report.");
    await operations.report("Marketplace report", result);

    expect(requests).toEqual([{ operation: "discover", threadId: THREAD }]);
    expect(dialogs.requests.at(-1)).toMatchObject({
      kind: "editor",
      title: "Marketplace report",
      prefill: "A marketplace report; do not parse this text.",
      readOnly: true,
    });
  });

  test("a missing gateway capability refuses before opening a confirmation or sending a command", async () => {
    const dialogs = new ScriptedDialogs(
      [answered({ kind: "input", value: "owner/repository" })],
      [true],
    );
    const { operations, requests } = setup(dialogs, { gatewayAvailable: false });

    await expect(operations.add()).rejects.toMatchObject({
      appError: { code: "unavailable", capability: I2CapabilityKeys.commandGateway },
    });
    expect(dialogs.confirmations).toHaveLength(0);
    expect(requests).toEqual([]);
  });
});
