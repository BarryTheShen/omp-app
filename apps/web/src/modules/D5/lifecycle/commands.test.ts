import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import {
  AppFailure,
  type CapabilityMap,
  type CommandRunResult,
  type ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type { DialogHost } from "../../U4/contract/dialog-host";
import type {
  SessionCapabilitiesSource,
  SessionInfoSnapshot,
  SessionInfoSource,
} from "../contract";
import {
  SESSION_LIFECYCLE_CAPABILITIES,
  SessionLifecycleController,
  type SessionLifecycleGateway,
  type SessionLifecycleOptions,
} from "./commands";

const threadId = "d5-lifecycle-thread" as ThreadId;
const alternateThreadId = "d5-lifecycle-other-thread" as ThreadId;
const sessionSnapshot: SessionInfoSnapshot = {
  id: threadId,
  title: "Current chat",
  cwd: "/workspace/project" as SessionInfoSnapshot["cwd"] & string,
  sessionFile: "/workspace/project/.omp/session.jsonl" as SessionInfoSnapshot["sessionFile"] &
    string,
  session: {
    model: null,
    thinkingLevel: null,
    sessionName: "Current chat",
    contextUsage: null,
    isCompacting: false,
    autoCompactionEnabled: null,
    tokensPerSecond: null,
    goal: null,
    revision: 1,
  },
};
const freshResult: CommandRunResult = {
  command: "/fresh",
  status: "completed",
  agentInvoked: false,
  promptSettled: true,
  sessionSettled: true,
  outputs: [{ text: "Fresh provider session started (0 provider states pruned)." }],
  sessionUpdates: [],
  configUpdates: [],
};
const AVAILABLE_CAPABILITIES: CapabilityMap = {
  "omp.cmd.new_session": { state: "available", via: "rpc" },
  "host.command-gateway": { state: "available", via: "host" },
};

function capabilitySource(overrides: Partial<CapabilityMap> = {}): SessionCapabilitiesSource {
  const snapshot = { ...AVAILABLE_CAPABILITIES, ...overrides };
  return { getSnapshot: () => snapshot };
}

function selectableSession(initialThreadId = threadId) {
  let currentThreadId = initialThreadId;
  const source: SessionInfoSource = {
    getSnapshot: () => ({ ...sessionSnapshot, id: currentThreadId }),
    subscribe: () => () => undefined,
  };
  return {
    source,
    select(nextThreadId: ThreadId) {
      currentThreadId = nextThreadId;
    },
  };
}

function createController(overrides: Partial<SessionLifecycleOptions> = {}) {
  return new SessionLifecycleController({
    remote: overrides.remote ?? {
      initialize: vi.fn<Pick<RemoteThreadListAdapter, "initialize">["initialize"]>(async () => ({
        remoteId: threadId,
      })),
    },
    gateway: overrides.gateway ?? {
      run: vi.fn<SessionLifecycleGateway["run"]>(async () => freshResult),
    },
    dialogs: overrides.dialogs ?? {
      confirm: vi.fn<DialogHost["confirm"]>(async () => true),
    },
    capabilities: overrides.capabilities ?? capabilitySource(),
    session: overrides.session ?? selectableSession().source,
  });
}

describe("SessionLifecycleController", () => {
  test("starts a new session through R1's existing A0 path", async () => {
    const initialize = vi.fn<Pick<RemoteThreadListAdapter, "initialize">["initialize"]>(
      async () => ({
        remoteId: threadId,
      }),
    );
    const run = vi.fn<SessionLifecycleGateway["run"]>(async () => freshResult);
    const controller = createController({ remote: { initialize }, gateway: { run } });

    await expect(controller.newSession()).resolves.toEqual({
      status: "completed",
      value: threadId,
    });
    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledWith("new");
    expect(run).not.toHaveBeenCalled();
  });

  test("returns an unavailable reason without opening a session when new_session is unsupported", async () => {
    const initialize = vi.fn<Pick<RemoteThreadListAdapter, "initialize">["initialize"]>(
      async () => ({
        remoteId: threadId,
      }),
    );
    const controller = createController({
      remote: { initialize },
      capabilities: capabilitySource({
        "omp.cmd.new_session": {
          state: "unavailable",
          via: "rpc",
          detail: "This omp connection cannot start a new session.",
        },
      }),
    });

    expect(controller.getAvailability("new")).toEqual({
      state: "unavailable",
      capability: SESSION_LIFECYCLE_CAPABILITIES.new,
      reason: "This omp connection cannot start a new session.",
    });
    await expect(controller.newSession()).resolves.toMatchObject({
      status: "unavailable",
      error: {
        code: "unavailable",
        capability: "omp.cmd.new_session",
        message: "This omp connection cannot start a new session.",
      },
    });
    expect(initialize).not.toHaveBeenCalled();
  });

  test("maps R1 new-session failures to typed results", async () => {
    const initialize = vi.fn<Pick<RemoteThreadListAdapter, "initialize">["initialize"]>(
      async () => {
        throw new AppFailure({
          code: "unavailable",
          message: "The selected folder is no longer available.",
          retryable: false,
          capability: "host.session-files",
        });
      },
    );
    const controller = createController({ remote: { initialize } });

    await expect(controller.newSession()).resolves.toMatchObject({
      status: "unavailable",
      error: {
        code: "unavailable",
        capability: "host.session-files",
        message: "The selected folder is no longer available.",
      },
    });
    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledWith("new");
  });

  test("gates clear with a plain reason because the RPC command gateway cannot execute it", async () => {
    const run = vi.fn<SessionLifecycleGateway["run"]>(async () => freshResult);
    const confirm = vi.fn<DialogHost["confirm"]>(async () => true);
    const controller = createController({ gateway: { run }, dialogs: { confirm } });

    expect(controller.getAvailability("clear")).toEqual({
      state: "unavailable",
      capability: "upstream.session-clear",
      reason: "Clearing the conversation only works in the omp terminal for now.",
    });
    await expect(controller.clear()).resolves.toMatchObject({
      status: "unavailable",
      error: {
        code: "unavailable",
        capability: "upstream.session-clear",
        message: "Clearing the conversation only works in the omp terminal for now.",
      },
    });
    expect(run).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  test("confirms fresh through U4 and returns the typed A1.8 result unchanged", async () => {
    const confirm = vi.fn<DialogHost["confirm"]>(async () => true);
    const run = vi.fn<SessionLifecycleGateway["run"]>(async () => freshResult);
    const controller = createController({ gateway: { run }, dialogs: { confirm } });

    await expect(controller.fresh()).resolves.toEqual({ status: "completed", value: freshResult });
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "confirm",
        title: "Start a fresh connection to the model?",
        message:
          "This can fix a stuck or confused reply. Your conversation stays exactly as it is.",
      }),
      { threadId, origin: "app" },
    );
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith({ threadId, command: "/fresh" }, undefined);
  });

  test("does not run fresh when U4 denies or cancels confirmation", async () => {
    const confirm = vi.fn<DialogHost["confirm"]>(async () => false);
    const run = vi.fn<SessionLifecycleGateway["run"]>(async () => freshResult);
    const controller = createController({ gateway: { run }, dialogs: { confirm } });

    await expect(controller.fresh()).resolves.toEqual({ status: "cancelled" });
    expect(run).not.toHaveBeenCalled();
  });

  test("refuses to refresh a session that changed while confirmation was open", async () => {
    const currentSession = selectableSession();
    const confirm = vi.fn<DialogHost["confirm"]>(async () => {
      currentSession.select(alternateThreadId);
      return true;
    });
    const run = vi.fn<SessionLifecycleGateway["run"]>(async () => freshResult);
    const controller = createController({
      session: currentSession.source,
      gateway: { run },
      dialogs: { confirm },
    });

    await expect(controller.fresh()).resolves.toMatchObject({
      status: "error",
      error: { code: "conflict" },
    });
    expect(run).not.toHaveBeenCalled();
  });

  test("gates fresh when A1.8 is unavailable and preserves gateway failures", async () => {
    const confirm = vi.fn<DialogHost["confirm"]>(async () => true);
    const run = vi.fn<SessionLifecycleGateway["run"]>(async () => {
      throw new AppFailure({
        code: "unavailable",
        message: "The /fresh command is not available in this omp session.",
        retryable: false,
        capability: "host.command-gateway",
      });
    });
    const unavailable = createController({
      capabilities: capabilitySource({
        "host.command-gateway": {
          state: "unavailable",
          via: "host",
          detail: "The command gateway is unavailable.",
        },
      }),
      gateway: { run },
      dialogs: { confirm },
    });

    expect(unavailable.getAvailability("fresh")).toEqual({
      state: "unavailable",
      capability: "host.command-gateway",
      reason: "The command gateway is unavailable.",
    });
    await expect(unavailable.fresh()).resolves.toMatchObject({ status: "unavailable" });
    expect(confirm).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();

    const available = createController({ gateway: { run }, dialogs: { confirm } });
    await expect(available.fresh()).resolves.toMatchObject({
      status: "unavailable",
      error: {
        code: "unavailable",
        capability: "host.command-gateway",
        message: "The /fresh command is not available in this omp session.",
      },
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith({ threadId, command: "/fresh" }, undefined);
  });

  test("keeps omp's own message when omp marks an idle /fresh as aborted, and treats a cancelled call as cancelled", async () => {
    // omp 18.7.0 answers an idle `/fresh` with its message and a prompt_result marked "aborted".
    const abortedResult: CommandRunResult = { ...freshResult, status: "aborted" };
    const run = vi.fn<SessionLifecycleGateway["run"]>(async () => abortedResult);
    const controller = createController({ gateway: { run } });
    await expect(controller.fresh()).resolves.toEqual({
      status: "completed",
      value: abortedResult,
    });

    // The user cancelling (the call's own signal) is what reports "cancelled".
    const cancelled = vi.fn<SessionLifecycleGateway["run"]>(async () => {
      throw new AppFailure({ code: "cancelled", message: "Cancelled", retryable: false });
    });
    await expect(createController({ gateway: { run: cancelled } }).fresh()).resolves.toEqual({
      status: "cancelled",
    });
  });
});
