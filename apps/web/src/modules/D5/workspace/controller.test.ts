import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityMap,
  type CommandRunResult,
  type FolderPath,
  HostMetadataPort,
  OmpCommandGateway,
  type PortClient,
  SlashCommand,
  type ThreadId,
  type WorkspaceState,
  WorkspaceStatePort,
} from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type { ConfirmDialogRequest, DialogRequest } from "../../U4/contract/dialog";
import type { DialogHost, DialogHostOpenOptions } from "../../U4/contract/dialog-host";
import type { DialogResult, DialogResultFor } from "../../U4/contract/responses";
import type {
  SessionCapabilitiesSource,
  SessionInfoSnapshot,
  SessionInfoSource,
} from "../contract";
import { WorkspaceController } from "./controller";
import { WORKTREE_UNAVAILABLE_REASON } from "./models";

const threadId = "d5-workspace-thread" as ThreadId;
const cwd = "/workspace/project" as FolderPath;
const sharedFolder = "/workspace/shared" as FolderPath;
const targetFolder = "/workspace/target" as FolderPath;
const observedAt = "2026-10-06T12:00:00.000Z";

const workspace: WorkspaceState = {
  folder: cwd,
  additionalDirectories: [sharedFolder],
  git: {
    repositoryRoot: cwd,
    branch: "main",
    head: "abc123",
    detached: false,
    dirtyFiles: [],
    ahead: 0,
    behind: 0,
    worktrees: [
      {
        path: sharedFolder,
        head: "def456",
        branch: "feature/shared",
        detached: false,
        bare: false,
        locked: false,
      },
    ],
    observedAt,
  },
  observedAt,
};

const capabilities: CapabilityMap = {
  "host.workspace-state": { state: "available", via: "host" },
  "host.metadata": { state: "available", via: "host" },
  "host.command-gateway": { state: "available", via: "host" },
};

function initialSession(): SessionInfoSnapshot {
  return {
    id: threadId,
    title: "Workspace test",
    cwd,
    sessionFile: null,
    session: {
      model: null,
      thinkingLevel: null,
      sessionName: "Workspace test",
      contextUsage: null,
      isCompacting: false,
      autoCompactionEnabled: null,
      tokensPerSecond: null,
      goal: null,
      revision: 1,
    },
  };
}

function infoSource(): SessionInfoSource {
  const snapshot = initialSession();
  return { getSnapshot: () => snapshot, subscribe: () => () => undefined };
}

function selectableSession() {
  let snapshot = initialSession();
  const listeners = new Set<(next: SessionInfoSnapshot) => void>();
  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe: (listener: (next: SessionInfoSnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } satisfies SessionInfoSource,
    select(next: SessionInfoSnapshot) {
      snapshot = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function capabilitySource(overrides: Partial<CapabilityMap> = {}): SessionCapabilitiesSource {
  const snapshot = { ...capabilities, ...overrides };
  return { getSnapshot: () => snapshot };
}

function commandResult(command: string, text = ""): CommandRunResult {
  return {
    command: SlashCommand.parse(command),
    status: "completed",
    agentInvoked: false,
    promptSettled: true,
    sessionSettled: true,
    outputs: text ? [{ text }] : [],
    sessionUpdates: [],
    configUpdates: [],
  };
}

class FakeDialogs implements Pick<DialogHost, "open" | "confirm"> {
  public readonly opened: Array<{ request: DialogRequest; options: DialogHostOpenOptions }> = [];
  public readonly confirmations: Array<{
    request: ConfirmDialogRequest;
    options: DialogHostOpenOptions;
  }> = [];
  public readonly responses: DialogResult[] = [];
  public readonly confirmResponses: boolean[] = [];

  public async open<Request extends DialogRequest>(
    request: Request,
    options: DialogHostOpenOptions,
  ): Promise<DialogResultFor<Request>> {
    this.opened.push({ request, options });
    const response = this.responses.shift();
    if (!response) throw new Error("No dialog response was queued.");
    return response as DialogResultFor<Request>;
  }

  public async confirm(
    request: ConfirmDialogRequest,
    options: DialogHostOpenOptions,
  ): Promise<boolean> {
    this.confirmations.push({ request, options });
    const response = this.confirmResponses.shift();
    if (response === undefined) throw new Error("No confirmation response was queued.");
    return response;
  }

  public input(value: string): void {
    this.responses.push({ outcome: "answered", response: { kind: "input", value } });
  }

  public select(value: string): void {
    this.responses.push({ outcome: "answered", response: { kind: "select", value } });
  }
}

function createController(
  options: {
    readonly workspaceRead?: PortClient<typeof WorkspaceStatePort>["read"];
    readonly metadataRead?: PortClient<typeof HostMetadataPort>["read"];
    readonly run?: PortClient<typeof OmpCommandGateway>["run"];
    readonly dialogs?: FakeDialogs;
    readonly capabilities?: SessionCapabilitiesSource;
    readonly session?: SessionInfoSource;
  } = {},
) {
  const workspaceRead =
    options.workspaceRead ??
    vi.fn(async ({ folder }: { readonly folder: FolderPath }) => ({
      ...workspace,
      folder,
      git: { ...workspace.git, repositoryRoot: folder },
    }));
  const metadataRead =
    options.metadataRead ??
    vi.fn(async ({ folder }: { readonly folder: FolderPath }) => ({
      hostname: "omp-host",
      displayPath: folder,
    }));
  const run =
    options.run ??
    vi.fn(async ({ command }: { readonly command: SlashCommand }) => commandResult(command));
  const client = {
    port(port: { readonly name: string }) {
      if (port === WorkspaceStatePort) return { read: workspaceRead };
      if (port === HostMetadataPort) return { read: metadataRead };
      if (port === OmpCommandGateway) return { run };
      throw new Error(`Unexpected port: ${port.name}`);
    },
  } as unknown as AppClient;
  const dialogs = options.dialogs ?? new FakeDialogs();
  const controller = new WorkspaceController({
    client,
    session: options.session ?? infoSource(),
    capabilities: options.capabilities ?? capabilitySource(),
    dialogs,
  });
  return { controller, dialogs, workspaceRead, metadataRead, run };
}

function expectAppDialog(call: {
  readonly request: DialogRequest;
  readonly options: DialogHostOpenOptions;
}) {
  expect(call.options).toMatchObject({ threadId, origin: "app" });
  expect(call.request.id).toMatch(/^app-/);
}

function expectFirstAppDialog(dialogs: FakeDialogs) {
  const first = dialogs.opened[0];
  if (!first) throw new Error("Expected a local app-owned dialog.");
  expectAppDialog(first);
}

describe("D5 workspace controller", () => {
  test("refreshes A1 workspace state and keeps /dirs output opaque", async () => {
    const list = commandResult(
      "/dirs",
      "Workspace directories:\n  /workspace/project (working directory)",
    );
    const { controller, run, workspaceRead } = createController({
      run: vi.fn(async () => list),
    });

    await controller.refresh();

    expect(workspaceRead).toHaveBeenCalledWith({ folder: cwd }, undefined);
    expect(run).toHaveBeenCalledWith({ threadId, command: "/dirs" }, undefined);
    expect(controller.getSnapshot().workspace).toEqual(workspace);
    expect(controller.getSnapshot().directoryList).toBe(list);
    expect(controller.getSnapshot().directoryList?.outputs[0]?.text).toBe(
      "Workspace directories:\n  /workspace/project (working directory)",
    );
  });

  test("validates existing paths through A1 and sends add-dir through the typed gateway", async () => {
    const dialogs = new FakeDialogs();
    dialogs.input("/workspace/new folder");
    const { controller, dialogs: usedDialogs, metadataRead, run } = createController({ dialogs });

    await expect(controller.addDirectory()).resolves.toMatchObject({ status: "completed" });

    expect(metadataRead).toHaveBeenCalledWith({ folder: "/workspace/new folder" }, undefined);
    expect(run).toHaveBeenNthCalledWith(
      1,
      { threadId, command: "/add-dir /workspace/new folder" },
      undefined,
    );
    expect(run).toHaveBeenNthCalledWith(2, { threadId, command: "/dirs" }, undefined);
    expect(controller.getSnapshot().directoryList?.command).toBe("/dirs");
    expectFirstAppDialog(usedDialogs);
  });

  test("shows the approved exact missing-folder message and does not run a command", async () => {
    const dialogs = new FakeDialogs();
    dialogs.input(targetFolder);
    const metadataRead = vi.fn<PortClient<typeof HostMetadataPort>["read"]>(async () => {
      throw new AppFailure({ code: "not_found", message: "Missing folder", retryable: false });
    });
    const { controller, run } = createController({ dialogs, metadataRead });

    await expect(controller.addDirectory()).resolves.toMatchObject({
      status: "error",
      error: {
        code: "not_found",
        message: "This folder doesn't exist. Create it first, then pick it.",
      },
    });
    expect(run).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error?.message).toBe(
      "This folder doesn't exist. Create it first, then pick it.",
    );
  });

  test("moves only to a validated existing folder after a local app confirmation", async () => {
    const dialogs = new FakeDialogs();
    dialogs.select(sharedFolder);
    dialogs.confirmResponses.push(true);
    const list = commandResult("/dirs", "Workspace directories:");
    const move = commandResult(`/move ${sharedFolder}`, `Moved to ${sharedFolder}.`);
    const run = vi.fn(async ({ command }: { readonly command: SlashCommand }) =>
      command === "/dirs" ? list : move,
    );
    const { controller, metadataRead, workspaceRead } = createController({ dialogs, run });

    await expect(controller.moveSession()).resolves.toMatchObject({
      status: "completed",
      value: move,
    });

    expect(metadataRead).toHaveBeenCalledWith({ folder: sharedFolder }, undefined);
    expect(workspaceRead).toHaveBeenNthCalledWith(2, { folder: sharedFolder }, undefined);
    expect(controller.getSnapshot().workspace?.folder).toBe(sharedFolder);
    expect(run).toHaveBeenNthCalledWith(1, { threadId, command: "/dirs" }, undefined);
    expect(run).toHaveBeenNthCalledWith(
      2,
      { threadId, command: `/move ${sharedFolder}` },
      undefined,
    );
    expectFirstAppDialog(dialogs);
    expect(dialogs.confirmations[0]?.options).toMatchObject({ threadId, origin: "app" });
  });

  test("removes an additional directory after an app-owned confirmation and refreshes /dirs", async () => {
    const dialogs = new FakeDialogs();
    dialogs.input(sharedFolder);
    dialogs.confirmResponses.push(true);
    const { controller, dialogs: usedDialogs, run } = createController({ dialogs });

    await expect(controller.removeDirectory()).resolves.toMatchObject({ status: "completed" });

    expect(run).toHaveBeenNthCalledWith(
      1,
      { threadId, command: `/remove-dir ${sharedFolder}` },
      undefined,
    );
    expect(run).toHaveBeenNthCalledWith(2, { threadId, command: "/dirs" }, undefined);
    expect(usedDialogs.confirmations[0]?.options).toMatchObject({ threadId, origin: "app" });
    expectFirstAppDialog(usedDialogs);
  });

  test("does not remove a directory when the local confirmation is denied", async () => {
    const dialogs = new FakeDialogs();
    dialogs.input(sharedFolder);
    dialogs.confirmResponses.push(false);
    const { controller, run } = createController({ dialogs });

    await expect(controller.removeDirectory()).resolves.toEqual({ status: "cancelled" });
    expect(run).not.toHaveBeenCalled();
  });

  test("does not remove the active working directory", async () => {
    const dialogs = new FakeDialogs();
    dialogs.input(cwd);
    const { controller, run } = createController({ dialogs });

    await expect(controller.removeDirectory()).resolves.toMatchObject({
      status: "error",
      error: { code: "invalid_args" },
    });
    expect(run).not.toHaveBeenCalled();
  });

  test("adds SSH hosts via /ssh with optional fields and never sends key material", async () => {
    const dialogs = new FakeDialogs();
    dialogs.select("Add host");
    dialogs.input("build");
    dialogs.input("build.example.com");
    dialogs.input("");
    dialogs.input("");
    dialogs.input("");
    dialogs.select("Global");
    const { controller, run } = createController({ dialogs });

    await expect(controller.manageSsh()).resolves.toMatchObject({ status: "completed" });

    expect(run).toHaveBeenCalledWith(
      { threadId, command: '/ssh add "build" --host "build.example.com" --scope user' },
      undefined,
    );
    expect(dialogs.opened).toHaveLength(7);
    // User, port and identity file are one optional text dialog each, never an Add/Skip choice.
    const optionalTitles = dialogs.opened.flatMap(({ request }) =>
      request.kind === "input" && request.optional === true ? [request.title] : [],
    );
    expect(optionalTitles).toEqual([
      "SSH user (optional)",
      "SSH port (optional)",
      "Identity file path on the omp host (optional)",
    ]);
    for (const call of dialogs.opened) expectAppDialog(call);
  });

  test("keeps SSH list output raw and gates worktree with its exact reason", async () => {
    const dialogs = new FakeDialogs();
    dialogs.select("List hosts");
    const result = commandResult("/ssh list", "host-a | build.example.com | - | 22 [project]");
    const { controller, run } = createController({
      dialogs,
      run: vi.fn(async () => result),
    });

    await expect(controller.manageSsh()).resolves.toMatchObject({
      status: "completed",
      value: result,
    });
    expect(run).toHaveBeenCalledWith({ threadId, command: "/ssh list" }, undefined);
    expect(controller.getAvailability("worktree")).toMatchObject({
      state: "unavailable",
      capability: "upstream.worktree",
      reason: WORKTREE_UNAVAILABLE_REASON,
    });
    await expect(controller.worktree()).resolves.toMatchObject({
      status: "unavailable",
      error: { capability: "upstream.worktree", message: WORKTREE_UNAVAILABLE_REASON },
    });
  });

  test("runs /ssh help through the typed command gateway", async () => {
    const dialogs = new FakeDialogs();
    dialogs.select("Show help");
    const help = commandResult("/ssh help", "SSH host management");
    const { controller, run } = createController({
      dialogs,
      run: vi.fn(async () => help),
    });

    await expect(controller.manageSsh()).resolves.toMatchObject({
      status: "completed",
      value: help,
    });
    expect(run).toHaveBeenCalledWith({ threadId, command: "/ssh help" }, undefined);
    expectFirstAppDialog(dialogs);
  });

  test("removes SSH hosts only after a local app confirmation", async () => {
    const dialogs = new FakeDialogs();
    dialogs.select("Remove host");
    dialogs.input("build");
    dialogs.select("Global");
    dialogs.confirmResponses.push(true);
    const { controller, run } = createController({ dialogs });

    await expect(controller.manageSsh()).resolves.toMatchObject({ status: "completed" });

    expect(run).toHaveBeenCalledWith(
      { threadId, command: '/ssh remove "build" --scope user' },
      undefined,
    );
    expect(dialogs.confirmations[0]?.options).toMatchObject({ threadId, origin: "app" });
    for (const call of dialogs.opened) expectAppDialog(call);
  });

  test("leaves a cancelled SSH removal unchanged", async () => {
    const dialogs = new FakeDialogs();
    dialogs.select("Remove host");
    dialogs.input("build");
    dialogs.select("Project");
    dialogs.confirmResponses.push(false);
    const { controller, run } = createController({ dialogs });

    await expect(controller.manageSsh()).resolves.toEqual({ status: "cancelled" });
    expect(run).not.toHaveBeenCalled();
    expect(dialogs.confirmations[0]?.options).toMatchObject({ threadId, origin: "app" });
  });

  test("gates directory actions when A1.8 is unavailable", async () => {
    const { controller, dialogs, run } = createController({
      capabilities: capabilitySource({
        "host.command-gateway": {
          state: "unavailable",
          via: "host",
          detail: "Gateway disconnected.",
        },
      }),
    });

    await expect(controller.addDirectory()).resolves.toMatchObject({
      status: "unavailable",
      error: { message: "Gateway disconnected." },
    });
    expect(dialogs.opened).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });

  test("clears workspace snapshots when the selected session changes", async () => {
    const selection = selectableSession();
    const { controller } = createController({ session: selection.source });
    await controller.refresh();
    expect(controller.getSnapshot().workspace).toEqual(workspace);

    selection.select({
      ...selection.source.getSnapshot(),
      id: "other-workspace-thread" as ThreadId,
      cwd: "/workspace/other" as FolderPath,
    });

    expect(controller.getSnapshot()).toMatchObject({
      status: "idle",
      workspace: null,
      directoryList: null,
      lastCommand: null,
    });
    controller.dispose();
  });

  test("does not start a second action while a dialog is pending", async () => {
    const dialogs = new FakeDialogs();
    let resolveInput!: (result: DialogResult) => void;
    const pending = new Promise<DialogResult>((resolve) => {
      resolveInput = resolve;
    });
    dialogs.open = async <Request extends DialogRequest>(
      request: Request,
      options: DialogHostOpenOptions,
    ): Promise<DialogResultFor<Request>> => {
      dialogs.opened.push({ request, options });
      return pending as Promise<DialogResultFor<Request>>;
    };
    const { controller, run } = createController({ dialogs });
    const add = controller.addDirectory();

    await expect(controller.removeDirectory()).resolves.toMatchObject({
      status: "error",
      error: { code: "conflict" },
    });
    expect(controller.getSnapshot().busyAction).toBe("add-directory");
    resolveInput({ outcome: "cancelled", kind: "input", timedOut: false });
    await expect(add).resolves.toEqual({ status: "cancelled" });
    expect(run).not.toHaveBeenCalled();
  });
});
