import type { AppClient } from "@omp-app/client";
import {
  type CapabilityMap,
  type CommandRunResult,
  FolderPath,
  SlashCommand,
  ThreadId,
} from "@omp-app/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DialogResult } from "../../U4/contract/responses";
import { type SessionInfoSnapshot, type SessionInfoSource, SshHost } from "../contract";
import { D5_DESCRIPTORS } from "../descriptors/index";
import { WorkspaceController, type WorkspaceControllerOptions } from "../workspace/controller";
import type { WorkspacePanelActions, WorkspaceViewModel } from "../workspace/models";
import { WORKTREE_UNAVAILABLE_REASON } from "../workspace/models";
import { WorkspacePanelView } from "../workspace/view";

afterEach(cleanup);

const threadId = ThreadId.parse("d5-pins-thread");
const folder = FolderPath.parse("/workspace/project");
const sessionSnapshot: SessionInfoSnapshot = {
  id: threadId,
  title: "D5 pins test",
  cwd: folder,
  sessionFile: null,
  session: {
    model: null,
    thinkingLevel: null,
    sessionName: "D5 pins test",
    contextUsage: null,
    isCompacting: false,
    autoCompactionEnabled: null,
    tokensPerSecond: null,
    goal: null,
    revision: 1,
  },
};
const capabilities: CapabilityMap = {
  "host.workspace-state": { state: "available", via: "host" },
  "host.metadata": { state: "available", via: "host" },
  "host.command-gateway": { state: "available", via: "host" },
};

function sessionSource(): SessionInfoSource {
  return {
    getSnapshot: () => sessionSnapshot,
    subscribe: () => () => undefined,
  };
}

function viewModel(overrides: Partial<WorkspaceViewModel> = {}): WorkspaceViewModel {
  const enabled = { disabled: false, reason: null } as const;
  return {
    status: "ready",
    workspace: null,
    directoryList: null,
    lastCommand: null,
    lastCommandLabel: null,
    busyAction: null,
    error: null,
    actions: {
      refresh: enabled,
      "add-directory": enabled,
      "remove-directory": enabled,
      "move-session": enabled,
      "manage-ssh": enabled,
      worktree: { disabled: true, reason: WORKTREE_UNAVAILABLE_REASON },
    },
    ...overrides,
  };
}

function viewActions(): WorkspacePanelActions {
  return {
    onRefresh: vi.fn(),
    onAddDirectory: vi.fn(),
    onRemoveDirectory: vi.fn(),
    onMoveSession: vi.fn(),
    onManageSsh: vi.fn(),
    onWorktree: vi.fn(),
  };
}

// Scripted CommandRunResult fixtures use omp's typed result shape; they are not captured recordings.
function commandResult(
  command: string,
  status: CommandRunResult["status"] = "completed",
): CommandRunResult {
  return {
    command: SlashCommand.parse(command),
    status,
    agentInvoked: false,
    promptSettled: true,
    sessionSettled: true,
    outputs: [],
    sessionUpdates: [],
    configUpdates: [],
  };
}

describe("D5 behaviors left unpinned by the closing gate", () => {
  test("pins every D5 descriptor's coverage and capability gate in a literal table", () => {
    const expected = [
      { id: "D5.new", covers: ["C2.new"], requires: ["omp.cmd.new_session"] },
      { id: "D5.fresh", covers: ["C2.fresh"], requires: ["host.command-gateway"] },
      { id: "D5.clear", covers: ["C2.clear"], requires: ["upstream.session-clear"] },
      {
        id: "D5.session",
        covers: ["C1.session", "C1.session-info"],
        requires: ["omp.cmd.get_state"],
      },
      {
        id: "D5.delete",
        covers: ["C1.session-delete", "C2.delete"],
        requires: ["host.command-gateway"],
      },
      {
        id: "D5.pin",
        covers: ["C1.session-pin", "C2.pin"],
        requires: ["host.session-pins"],
      },
      { id: "D5.rename", covers: ["C2.rename"], requires: ["omp.cmd.set_session_name"] },
      { id: "D5.ssh", covers: ["C1.ssh"], requires: ["host.command-gateway"] },
      { id: "D5.sshAdd", covers: ["C1.ssh-add"], requires: ["host.command-gateway"] },
      { id: "D5.sshHelp", covers: ["C1.ssh-help"], requires: ["host.command-gateway"] },
      { id: "D5.sshList", covers: ["C1.ssh-list"], requires: ["host.command-gateway"] },
      { id: "D5.sshRemove", covers: ["C1.ssh-remove"], requires: ["host.command-gateway"] },
      {
        id: "D5.addDirectory",
        covers: ["C2.add-dir"],
        requires: ["host.workspace-state", "host.command-gateway"],
      },
      {
        id: "D5.listDirectories",
        covers: ["C2.dirs"],
        requires: ["host.workspace-state", "host.command-gateway"],
      },
      {
        id: "D5.removeDirectory",
        covers: ["C2.remove-dir"],
        requires: ["host.workspace-state", "host.command-gateway"],
      },
      {
        id: "D5.moveSession",
        covers: ["C2.move"],
        requires: ["host.workspace-state", "host.command-gateway"],
      },
      { id: "D5.worktree", covers: ["C2.wt"], requires: ["upstream.worktree"] },
      { id: "D5.restart", covers: ["C2.restart"], requires: ["host.command-gateway"] },
      { id: "D5.handoff", covers: ["C2.handoff"], requires: ["omp.cmd.handoff"] },
      { id: "D5.retry", covers: ["C2.retry"], requires: ["host.command-gateway"] },
      { id: "D5.newNamespace", covers: [], requires: ["omp.cmd.new_session"] },
      { id: "D5.clearNamespace", covers: [], requires: ["upstream.session-clear"] },
      {
        id: "D5.moveDirectoryOverlay",
        covers: ["C2.move-directory-overlay"],
        requires: ["host.workspace-state", "host.command-gateway"],
      },
      {
        id: "D5.handoffSummaryDivider",
        covers: ["C2.handoff-summary-divider"],
        requires: ["omp.cmd.handoff"],
      },
    ] as const;
    const byId = new Map(D5_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor] as const));

    expect(D5_DESCRIPTORS).toHaveLength(expected.length);
    for (const row of expected) {
      const descriptor = byId.get(row.id);
      expect(descriptor?.covers, `${row.id} inventory coverage`).toEqual(row.covers);
      expect(descriptor?.requires, `${row.id} capability gate`).toEqual(row.requires);
    }
  });

  test("labels an aborted last workspace command as Cancelled", () => {
    render(
      <WorkspacePanelView
        model={viewModel({
          lastCommand: commandResult("/add-dir /workspace/shared", "aborted"),
          lastCommandLabel: "Add directory",
        })}
        actions={viewActions()}
      />,
    );

    const region = screen.getByRole("region", { name: "Last workspace command" });
    expect(within(region).getByText("Cancelled")).toBeTruthy();
    expect(within(region).queryByText("Completed")).toBeNull();
  });

  test("shows the label paired with the last workspace command", () => {
    render(
      <WorkspacePanelView
        model={viewModel({
          lastCommand: commandResult("/add-dir /workspace/shared"),
          lastCommandLabel: "Add directory",
        })}
        actions={viewActions()}
      />,
    );

    const region = screen.getByRole("region", { name: "Last workspace command" });
    expect(within(region).getByRole("heading", { name: "Add directory" })).toBeTruthy();
  });

  test("reads the busy-action reason from WorkspaceController", async () => {
    const dialogStarted = Promise.withResolvers<void>();
    const dialogResult = Promise.withResolvers<DialogResult>();
    const dialogs = {
      open: async () => {
        dialogStarted.resolve();
        return dialogResult.promise;
      },
      confirm: async () => false,
    } as unknown as WorkspaceControllerOptions["dialogs"];
    const client = { port: () => ({}) } as unknown as AppClient;
    const controller = new WorkspaceController({
      client,
      session: sessionSource(),
      capabilities: { getSnapshot: () => capabilities },
      dialogs,
    });
    const addDirectory = controller.addDirectory();

    try {
      await dialogStarted.promise;
      const model = controller.getSnapshot();
      expect(model.busyAction).toBe("add-directory");
      expect(model.actions["remove-directory"]).toEqual({
        disabled: true,
        reason: "Another workspace action is running.",
      });
    } finally {
      dialogResult.resolve({ kind: "input", outcome: "cancelled", timedOut: false });
      await addDirectory;
      controller.dispose();
    }
  });

  test("keeps the worktree refusal's hint to use omp's terminal", () => {
    render(<WorkspacePanelView model={viewModel()} actions={viewActions()} />);

    const worktree = screen.getByRole("button", { name: "Create or move to worktree" });
    expect(worktree.getAttribute("title")).toBe(
      "Worktree relocation isn't available in the app yet. Use omp's terminal for now.",
    );
    expect(
      screen.getByText(
        "Worktree relocation isn't available in the app yet. Use omp's terminal for now.",
      ),
    ).toBeTruthy();
  });

  test("rejects an empty SSH identity-file label", () => {
    expect(
      SshHost.safeParse({
        name: "build-server",
        host: "build.example.com",
        keyLabel: "",
        scope: "project",
      }).success,
    ).toBe(false);
  });

  test("renders every workspace action as a non-submitting button", () => {
    render(<WorkspacePanelView model={viewModel()} actions={viewActions()} />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(6);
    for (const button of buttons) expect(button.getAttribute("type")).toBe("button");
  });
});
