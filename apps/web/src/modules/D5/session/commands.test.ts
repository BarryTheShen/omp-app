import { AppFailure, type CapabilityMap, type ThreadId } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type {
  SessionActionSeam,
  SessionCapabilitiesSource,
  SessionInfoSnapshot,
  SessionInfoSource,
} from "../contract";
import { SessionCommandController } from "./commands";

const threadId = "d5-command-thread" as ThreadId;
const session: SessionInfoSnapshot = {
  id: threadId,
  title: "Current chat",
  cwd: "/workspace/project" as SessionInfoSnapshot["cwd"] & string,
  sessionFile: "/workspace/project/.omp/d5.jsonl" as SessionInfoSnapshot["sessionFile"] & string,
  session: {
    model: null,
    thinkingLevel: null,
    sessionName: "Current chat",
    contextUsage: null,
    isCompacting: false,
    autoCompactionEnabled: null,
    tokensPerSecond: null,
    goal: null,
    revision: 4,
  },
};
const AVAILABLE_CAPABILITIES: CapabilityMap = {
  "omp.cmd.get_state": { state: "available", via: "rpc" },
  "omp.cmd.set_session_name": { state: "available", via: "rpc" },
  "host.session-pins": { state: "available", via: "host" },
  "host.command-gateway": { state: "available", via: "host" },
};

function capabilitySource(overrides: Partial<CapabilityMap> = {}): SessionCapabilitiesSource {
  const snapshot = { ...AVAILABLE_CAPABILITIES, ...overrides };
  return { getSnapshot: () => snapshot };
}

function infoSource(): SessionInfoSource {
  return {
    getSnapshot: () => session,
    subscribe: () => () => undefined,
  };
}

function selectedSession() {
  return {
    getSnapshot: () => ({
      id: threadId,
      title: session.title,
      displayTitle: session.title,
      cwd: session.cwd,
      sessionFile: session.sessionFile,
    }),
  };
}

function actions(): SessionActionSeam {
  return {
    rename: vi.fn<SessionActionSeam["rename"]>(async () => ({
      status: "completed",
      value: undefined,
    })),
    delete: vi.fn<SessionActionSeam["delete"]>(async () => ({
      status: "completed",
      value: undefined,
    })),
    setPinned: vi.fn<SessionActionSeam["setPinned"]>(async (args) => ({
      status: "completed",
      value: { sessionId: args, pinned: true, revision: "r2" },
    })),
    getPinAvailability: vi.fn(() => ({
      state: "available" as const,
      capability: "host.session-pins",
    })),
  };
}

describe("SessionCommandController", () => {
  test("routes rename through R1.7 and does not mutate selected metadata", async () => {
    const seam = actions();
    const controller = new SessionCommandController({
      actions: seam,
      selectedSession: selectedSession(),
      info: infoSource(),
      capabilities: capabilitySource(),
    });

    await expect(controller.rename({ title: "  Renamed  " })).resolves.toEqual({
      status: "completed",
      value: undefined,
    });
    expect(seam.rename).toHaveBeenCalledWith(
      {
        id: threadId,
        title: session.title,
        displayTitle: session.title,
        cwd: session.cwd,
        sessionFile: session.sessionFile,
      },
      "Renamed",
    );
    expect(controller.getSnapshot()).toBe(session);
  });

  test("routes pin through R1.7's CAS action and preserves its typed result", async () => {
    const seam = actions();
    const controller = new SessionCommandController({
      actions: seam,
      selectedSession: selectedSession(),
      info: infoSource(),
      capabilities: capabilitySource(),
    });

    await expect(controller.pin({ pinned: true, expectedRevision: "r1" })).resolves.toMatchObject({
      status: "completed",
      value: { sessionId: threadId, pinned: true, revision: "r2" },
    });
    expect(seam.setPinned).toHaveBeenCalledWith(threadId, true, "r1");
  });

  test("routes delete through R1.7 and maps AppFailure without touching session files", async () => {
    const seam = actions();
    vi.mocked(seam.delete).mockResolvedValueOnce({
      status: "error",
      error: new AppFailure({
        code: "permission",
        message: "omp rejected delete",
        retryable: false,
      }),
    });
    const controller = new SessionCommandController({
      actions: seam,
      selectedSession: selectedSession(),
      info: infoSource(),
      capabilities: capabilitySource(),
    });

    await expect(controller.delete({ confirmationId: "delete-d5" })).resolves.toMatchObject({
      status: "error",
      error: { code: "permission", message: "omp rejected delete" },
    });
    expect(seam.delete).toHaveBeenCalledWith(
      {
        id: threadId,
        title: session.title,
        displayTitle: session.title,
        cwd: session.cwd,
        sessionFile: session.sessionFile,
      },
      "delete-d5",
    );
  });

  test("gates unsupported RPC and host actions with the reported reasons", async () => {
    const seam = actions();
    const controller = new SessionCommandController({
      actions: seam,
      selectedSession: selectedSession(),
      info: infoSource(),
      capabilities: capabilitySource({
        "omp.cmd.get_state": {
          state: "unavailable",
          via: "rpc",
          detail: "Session info is unavailable.",
        },
        "omp.cmd.set_session_name": {
          state: "unavailable",
          via: "rpc",
          detail: "Rename requires a newer omp.",
        },
        "host.command-gateway": {
          state: "unavailable",
          via: "host",
          detail: "Native session deletion is unavailable.",
        },
      }),
    });

    expect(controller.getAvailability("info")).toEqual({
      state: "unavailable",
      capability: "omp.cmd.get_state",
      reason: "Session info is unavailable.",
    });
    expect(controller.getAvailability("rename")).toMatchObject({
      state: "unavailable",
      capability: "omp.cmd.set_session_name",
      reason: "Rename requires a newer omp.",
    });
    await expect(controller.rename({ title: "Renamed" })).resolves.toMatchObject({
      status: "unavailable",
      error: {
        code: "unavailable",
        capability: "omp.cmd.set_session_name",
        message: "Rename requires a newer omp.",
      },
    });
    await expect(controller.delete()).resolves.toMatchObject({
      status: "unavailable",
      error: {
        code: "unavailable",
        capability: "host.command-gateway",
        message: "Native session deletion is unavailable.",
      },
    });
    expect(seam.rename).not.toHaveBeenCalled();
    expect(seam.delete).not.toHaveBeenCalled();
  });

  test("reports an unavailable pin capability without invoking the R1.7 pin action", async () => {
    const seam = actions();
    vi.mocked(seam.getPinAvailability).mockReturnValue({
      state: "unavailable",
      capability: "host.session-pins",
      reason: "Pin store is offline.",
    });
    const controller = new SessionCommandController({
      actions: seam,
      selectedSession: selectedSession(),
      info: infoSource(),
      capabilities: capabilitySource(),
    });

    expect(controller.getAvailability("pin")).toEqual({
      state: "unavailable",
      capability: "host.session-pins",
      reason: "Pin store is offline.",
    });
    await expect(controller.pin({ pinned: true, expectedRevision: null })).resolves.toMatchObject({
      status: "unavailable",
      error: {
        code: "unavailable",
        capability: "host.session-pins",
        message: "Pin store is offline.",
      },
    });
    expect(seam.setPinned).not.toHaveBeenCalled();
  });

  test("rejects a stale or absent selected session before calling R1.7", async () => {
    const seam = actions();
    const stale = new SessionCommandController({
      actions: seam,
      selectedSession: {
        getSnapshot: () => ({
          id: "other-thread" as ThreadId,
          title: "Other",
          displayTitle: "Other",
          cwd: session.cwd,
          sessionFile: session.sessionFile,
        }),
      },
      info: infoSource(),
      capabilities: capabilitySource(),
    });
    await expect(stale.rename({ title: "Nope" })).resolves.toMatchObject({
      status: "error",
      error: { code: "conflict" },
    });
    expect(seam.rename).not.toHaveBeenCalled();

    const absent = new SessionCommandController({
      actions: seam,
      selectedSession: { getSnapshot: () => null },
      info: infoSource(),
      capabilities: capabilitySource(),
    });
    await expect(absent.delete()).resolves.toMatchObject({
      status: "error",
      error: { code: "not_found" },
    });
    expect(seam.delete).not.toHaveBeenCalled();
  });
});
