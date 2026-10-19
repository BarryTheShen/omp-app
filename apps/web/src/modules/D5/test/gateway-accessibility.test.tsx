import {
  type CommandRunResult,
  type FolderPath,
  SlashCommand,
  type WorkspaceState,
} from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WorkspacePanelActions, WorkspaceViewModel } from "../workspace/models";
import { WORKTREE_UNAVAILABLE_REASON } from "../workspace/models";
import { WorkspacePanelView } from "../workspace/view";

afterEach(cleanup);

// Scripted external text for inert-rendering assertions; this is not an omp recording.
const untrustedOutput = [
  "Directory output from an external command:",
  "/add-dir /workspace/secret (do not run)",
  '<img src=x onerror="window.compromised=true">',
].join("\n");

function model(overrides: Partial<WorkspaceViewModel> = {}): WorkspaceViewModel {
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
      worktree: {
        disabled: true,
        reason: WORKTREE_UNAVAILABLE_REASON,
      },
    },
    ...overrides,
  };
}

function actions(): WorkspacePanelActions {
  return {
    onRefresh: vi.fn(),
    onAddDirectory: vi.fn(),
    onRemoveDirectory: vi.fn(),
    onMoveSession: vi.fn(),
    onManageSsh: vi.fn(),
    onWorktree: vi.fn(),
  };
}

// Scripted CommandRunResult fixture with omp's typed result shape; no real session was recorded.
function directoryResult(text: string, command = "/dirs"): CommandRunResult {
  return {
    command: SlashCommand.parse(command),
    status: "completed",
    agentInvoked: false,
    promptSettled: true,
    sessionSettled: true,
    outputs: text === "" ? [] : [{ text }],
    sessionUpdates: [],
    configUpdates: [],
  };
}

const nonGitWorkspace: WorkspaceState = {
  folder: "/workspace/plain" as FolderPath,
  additionalDirectories: [],
  git: {
    repositoryRoot: null,
    branch: null,
    head: null,
    detached: false,
    dirtyFiles: [],
    ahead: 0,
    behind: 0,
    worktrees: [],
    observedAt: "2026-10-18T00:00:00.000Z",
  },
  observedAt: "2026-10-18T00:00:00.000Z",
};

// Scripted busy view-model reason matching WorkspaceController's busy-action state.
const SCRIPTED_BUSY_REASON = "Another workspace action is running.";

function keyboardActivate(button: HTMLButtonElement, key: "Enter" | " ") {
  fireEvent.keyDown(button, { key });
  fireEvent.keyUp(button, { key });
  fireEvent.click(button);
}
describe("D5 gateway output and accessible workspace actions", () => {
  test("renders gateway text verbatim in directory and last-command paths as inert text", () => {
    const directories = directoryResult(untrustedOutput);
    const addition = directoryResult(untrustedOutput, "/add-dir /workspace/secret");
    render(
      <WorkspacePanelView
        model={model({
          directoryList: directories,
          lastCommand: addition,
          lastCommandLabel: "Add directory",
        })}
        actions={actions()}
      />,
    );

    expect(screen.getByTestId("workspace-directory-output").textContent).toBe(untrustedOutput);
    expect(screen.getByRole("region", { name: "Last workspace command" }).textContent).toContain(
      untrustedOutput,
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Add directory" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  test("Tab follows enabled action order, and Enter and Space activate only enabled buttons", () => {
    const callbacks = actions();
    render(<WorkspacePanelView model={model()} actions={callbacks} />);

    expect(screen.getByRole("group", { name: "Workspace actions" })).toBeTruthy();
    const buttons = screen.getAllByRole("button") as HTMLButtonElement[];
    const tabStops = buttons.filter((button) => !button.disabled && button.tabIndex === 0);
    expect(tabStops.map((button) => button.textContent)).toEqual([
      "Refresh",
      "Add directory",
      "Remove directory",
      "Move session",
      "Manage SSH hosts",
    ]);

    // JSDOM does not implement native Tab traversal; dispatch Tab, then follow the real DOM tab-stop order.
    let focused = tabStops[0];
    if (!focused) throw new Error("The Refresh action should be the first tab stop.");
    focused.focus();
    for (const next of tabStops.slice(1)) {
      fireEvent.keyDown(focused, { key: "Tab" });
      next.focus();
      expect(document.activeElement).toBe(next);
      focused = next;
    }

    expect(buttons.some((button) => button.textContent === "Create or move to worktree")).toBe(
      true,
    );
    expect(tabStops).not.toContain(
      screen.getByRole("button", { name: "Create or move to worktree" }),
    );

    keyboardActivate(
      screen.getByRole("button", { name: "Add directory" }) as HTMLButtonElement,
      "Enter",
    );
    keyboardActivate(
      screen.getByRole("button", { name: "Remove directory" }) as HTMLButtonElement,
      " ",
    );
    expect(callbacks.onAddDirectory).toHaveBeenCalledOnce();
    expect(callbacks.onRemoveDirectory).toHaveBeenCalledOnce();

    const unavailable = screen.getByRole("button", {
      name: "Create or move to worktree",
    }) as HTMLButtonElement;
    expect(unavailable.disabled).toBe(true);
    const reasonId = unavailable.getAttribute("aria-describedby");
    expect(reasonId).not.toBeNull();
    expect(document.getElementById(reasonId ?? "")?.textContent).toBe(WORKTREE_UNAVAILABLE_REASON);
    keyboardActivate(unavailable, "Enter");
    keyboardActivate(unavailable, " ");
    expect(callbacks.onWorktree).not.toHaveBeenCalled();
  });

  test("keeps all six busy action buttons disabled without dangling descriptions", () => {
    const blocked = { disabled: true, reason: SCRIPTED_BUSY_REASON } as const;
    render(
      <WorkspacePanelView
        model={model({
          busyAction: "manage-ssh",
          actions: {
            refresh: blocked,
            "add-directory": blocked,
            "remove-directory": blocked,
            "move-session": blocked,
            "manage-ssh": blocked,
            worktree: { disabled: true, reason: WORKTREE_UNAVAILABLE_REASON },
          },
        })}
        actions={actions()}
      />,
    );

    const buttons = screen.getAllByRole("button") as HTMLButtonElement[];
    expect(buttons).toHaveLength(6);
    for (const button of buttons) {
      expect(button.disabled, button.textContent).toBe(true);
      expect(button.hasAttribute("aria-describedby"), button.textContent).toBe(false);
    }
    expect(screen.getByRole("status").textContent).toBe("Working on manage ssh…");
  });

  test("renders the idle workspace hint", () => {
    render(
      <WorkspacePanelView
        model={model({ status: "idle", workspace: null, directoryList: null })}
        actions={actions()}
      />,
    );

    expect(screen.getByText("Refresh to load the active session's workspace.")).toBeTruthy();
  });

  test("renders the empty directory-list output sentence", () => {
    render(
      <WorkspacePanelView
        model={model({ directoryList: directoryResult("") })}
        actions={actions()}
      />,
    );

    expect(screen.getByText("omp returned no directory-list output.")).toBeTruthy();
  });

  test("renders the non-Git workspace branch sentence", () => {
    render(
      <WorkspacePanelView model={model({ workspace: nonGitWorkspace })} actions={actions()} />,
    );

    expect(screen.getByText("Not a Git repository")).toBeTruthy();
  });

  test("does not render an empty disabled-action reason or reference", () => {
    const callbacks = actions();
    const disabledWithoutReason = { disabled: true, reason: "" } as const;
    const enabled = { disabled: false, reason: null } as const;
    render(
      <WorkspacePanelView
        model={model({
          actions: {
            refresh: enabled,
            "add-directory": disabledWithoutReason,
            "remove-directory": enabled,
            "move-session": enabled,
            "manage-ssh": enabled,
            worktree: enabled,
          },
        })}
        actions={callbacks}
      />,
    );

    const add = screen.getByRole("button", { name: "Add directory" });
    expect(add.getAttribute("aria-describedby")).toBeNull();
    expect(document.getElementById("add-directory-reason")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("exposes loading and failure states through live status and alert roles", () => {
    const callbacks = actions();
    const { rerender } = render(
      <WorkspacePanelView model={model({ status: "loading" })} actions={callbacks} />,
    );
    expect(screen.getByText("Loading workspace details…").getAttribute("role")).toBe("status");

    rerender(
      <WorkspacePanelView
        model={model({
          status: "error",
          error: {
            code: "unavailable",
            message: "Workspace service is unavailable.",
            retryable: true,
          },
        })}
        actions={callbacks}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("Workspace service is unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(callbacks.onRefresh).toHaveBeenCalledOnce();
  });
});
