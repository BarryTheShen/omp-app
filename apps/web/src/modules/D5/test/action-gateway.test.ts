import {
  type CapabilityMap,
  type CommandRunResult,
  type OpenThreadResult,
  SlashCommand,
  ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type { SessionCapabilitiesSource, SessionInfoSource } from "../contract";
import {
  SessionLifecycleController,
  type SessionLifecycleGateway,
  type SessionLifecycleOptions,
} from "../lifecycle/commands";

const threadId = ThreadId.parse("d5-gate-current");
const gatewayAnswer: CommandRunResult = {
  command: SlashCommand.parse("/fresh"),
  status: "completed",
  agentInvoked: false,
  promptSettled: true,
  sessionSettled: true,
  outputs: [{ text: "Fresh provider session started (0 provider states pruned)." }],
  sessionUpdates: [],
  configUpdates: [],
};

const startedResult: OpenThreadResult = {
  threadId,
  sessionFile: "/workspace/project/.omp/d5-gate-current.jsonl" as OpenThreadResult["sessionFile"],
  capabilities: {},
};

function harness(
  confirmed: boolean,
  capability: CapabilityMap = {
    "host.command-gateway": { state: "available", via: "host" },
  },
  confirmImplementation?: SessionLifecycleOptions["dialogs"]["confirm"],
) {
  const run = vi.fn<SessionLifecycleGateway["run"]>(async () => gatewayAnswer);
  const confirm = vi.fn<SessionLifecycleOptions["dialogs"]["confirm"]>(
    confirmImplementation ?? (async () => confirmed),
  );
  const startNew = vi.fn<SessionLifecycleOptions["remote"]["startNew"]>(async () => startedResult);
  const adopt = vi.fn<SessionLifecycleOptions["remote"]["adopt"]>(() => true);
  const options: SessionLifecycleOptions = {
    remote: { startNew, adopt },
    gateway: { run },
    dialogs: { confirm },
    capabilities: { getSnapshot: () => capability } satisfies SessionCapabilitiesSource,
    session: { getSnapshot: () => ({ id: threadId }) } as SessionInfoSource,
  };
  return { controller: new SessionLifecycleController(options), run, confirm, startNew };
}

describe("D5 lifecycle action and typed gateway boundary", () => {
  test("confirms fresh, sends the typed gateway command once, and returns its result without parsing output", async () => {
    const { controller, run, confirm, startNew } = harness(true);

    const outcome = await controller.fresh();

    expect(outcome).toEqual({ status: "completed", value: gatewayAnswer });
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      kind: "confirm",
      title: "Start a fresh connection to the model?",
      message: "This can fix a stuck or confused reply. Your conversation stays exactly as it is.",
    });
    expect(confirm.mock.calls[0]?.[1]).toEqual({ threadId, origin: "app" });
    expect(run).toHaveBeenCalledExactlyOnceWith(
      {
        threadId,
        command: SlashCommand.parse("/fresh"),
      },
      undefined,
    );
    expect(startNew).not.toHaveBeenCalled();
  });

  test("keeps the cancellation boundary ahead of the gateway call", async () => {
    const { controller, run } = harness(false);

    await expect(controller.fresh()).resolves.toEqual({ status: "cancelled" });
    expect(run).not.toHaveBeenCalled();
  });

  test("rechecks gateway availability after confirmation and refuses a newly unavailable gateway", async () => {
    const capability: CapabilityMap = {
      "host.command-gateway": { state: "available", via: "host" },
    };
    const { controller, run, confirm } = harness(true, capability, async () => {
      capability["host.command-gateway"] = {
        state: "unavailable",
        via: "host",
        detail: "Gateway paused by the host.",
      };
      return true;
    });

    await expect(controller.fresh()).resolves.toEqual({
      status: "unavailable",
      error: {
        code: "unavailable",
        message: "Gateway paused by the host.",
        retryable: false,
        capability: "host.command-gateway",
      },
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });
});
