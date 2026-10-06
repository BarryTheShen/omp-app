import {
  type AppError,
  type CommandRunResult,
  type FolderPath,
  SlashCommand,
  type WorkspaceState,
} from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WorkspacePanelActions, WorkspaceViewModel } from "./models";
import { WORKTREE_UNAVAILABLE_REASON } from "./models";
import { WorkspacePanelView } from "./view";

afterEach(cleanup);

const folder = `/workspace/${"very-long-path-segment/".repeat(10)}project` as FolderPath;
const observedAt = "2026-10-06T12:00:00.000Z";
const workspace: WorkspaceState = {
  folder,
  additionalDirectories: [],
  git: {
    repositoryRoot: folder,
    branch: "feature/workspace",
    head: "abc123",
    detached: false,
    dirtyFiles: [
      {
        path: "apps/web/src/modules/D5/workspace/view.tsx",
        status: "modified",
        staged: false,
        worktree: true,
      },
    ],
    ahead: 0,
    behind: 0,
    worktrees: [],
    observedAt,
  },
  observedAt,
};
const directoryList: CommandRunResult = {
  command: SlashCommand.parse("/dirs"),
  status: "completed",
  agentInvoked: false,
  promptSettled: true,
  sessionSettled: true,
  outputs: [
    {
      text: "Workspace directories:\n  /workspace/project (working directory)\n  /workspace/shared",
    },
  ],
  sessionUpdates: [],
  configUpdates: [],
};

function createModel(overrides: Partial<WorkspaceViewModel> = {}): WorkspaceViewModel {
  const enabled = { disabled: false, reason: null } as const;
  return {
    status: "ready",
    workspace,
    directoryList,
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

function createActions(): WorkspacePanelActions {
  return {
    onRefresh: vi.fn(),
    onAddDirectory: vi.fn(),
    onRemoveDirectory: vi.fn(),
    onMoveSession: vi.fn(),
    onManageSsh: vi.fn(),
    onWorktree: vi.fn(),
  };
}

describe("WorkspacePanelView", () => {
  test("renders typed workspace facts and raw /dirs output without parsing it", () => {
    render(<WorkspacePanelView model={createModel()} actions={createActions()} />);

    expect(screen.getByTestId("workspace-path").textContent).toContain(folder);
    expect(screen.getByText("feature/workspace").textContent).toBe("feature/workspace");
    const directoryOutput = screen.getByTestId("workspace-directory-output").textContent ?? "";
    expect(directoryOutput).toContain("Workspace directories:");
    expect(directoryOutput).toContain("/workspace/shared");
    expect(screen.getByText("1").textContent).toBe("1");
    expect(screen.getByText(WORKTREE_UNAVAILABLE_REASON).textContent).toContain(
      WORKTREE_UNAVAILABLE_REASON,
    );
  });

  test("passes actions through callbacks and keeps gated actions disabled", () => {
    const actions = createActions();
    render(<WorkspacePanelView model={createModel()} actions={actions} />);

    fireEvent.click(screen.getByRole("button", { name: "Add directory" }));
    expect(actions.onAddDirectory).toHaveBeenCalledOnce();
    expect(
      (screen.getByRole("button", { name: "Create or move to worktree" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("renders loading, empty, error and disabled reasons for recovery", () => {
    const error: AppError = {
      code: "unavailable",
      message: "Workspace state is unavailable for this connection.",
      retryable: false,
    };
    const disabled = { disabled: true, reason: "omp commands are unavailable." } as const;
    render(
      <WorkspacePanelView
        model={createModel({
          status: "loading",
          workspace: null,
          directoryList: null,
          error,
          actions: {
            refresh: { disabled: false, reason: null },
            "add-directory": disabled,
            "remove-directory": disabled,
            "move-session": disabled,
            "manage-ssh": disabled,
            worktree: { disabled: true, reason: WORKTREE_UNAVAILABLE_REASON },
          },
        })}
        actions={createActions()}
      />,
    );

    expect(screen.getByText("Loading workspace details…").textContent).toContain(
      "Loading workspace details",
    );
    expect(screen.getByRole("alert").textContent).toContain(error.message);
    expect(screen.getByText("No workspace location has been loaded.").textContent).toContain(
      "No workspace",
    );
    expect(screen.getAllByText("omp commands are unavailable.").length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
