import type {
  CapabilityMap,
  CommandRunResult,
  FolderPath,
  ThreadId,
  UiRequestId,
  WorkspaceState,
} from "@omp-app/contracts";
import { SlashCommand } from "@omp-app/contracts";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { OverlayHost, useOverlayHost } from "@/overlay";
import type { InputDialogRequest, SelectDialogRequest } from "../../U4/contract/dialog";
import type { DialogResultFor } from "../../U4/contract/responses";
import { renderDialogRequest } from "../../U4/dialogs";
import { DialogHostController } from "../../U4/host";
import type { WorkspacePanelActions, WorkspaceViewModel } from "./models";
import { WORKTREE_UNAVAILABLE_REASON } from "./models";
import { WorkspacePanelView } from "./view";

const threadId = "d5-3-workspace-playground" as ThreadId;
const currentFolder = "/workspaces/omp-app" as FolderPath;
const sharedFolder = "/workspaces/shared" as FolderPath;
const observedAt = "2026-10-06T12:00:00.000Z";
const noOmpUi: CapabilityMap = {};

const workspace: WorkspaceState = {
  folder: currentFolder,
  additionalDirectories: [sharedFolder],
  git: {
    repositoryRoot: currentFolder,
    branch: "feature/workspace-panel",
    head: "7b1d9ef",
    detached: false,
    dirtyFiles: [
      {
        path: "apps/web/src/modules/D5/workspace/view.tsx",
        status: "modified",
        staged: false,
        worktree: true,
      },
    ],
    ahead: 2,
    behind: 0,
    worktrees: [
      {
        path: sharedFolder,
        head: "6f012ab",
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

function commandResult(command: string, text: string): CommandRunResult {
  return {
    command: SlashCommand.parse(command),
    status: "completed",
    agentInvoked: false,
    promptSettled: true,
    sessionSettled: true,
    outputs: [{ text }],
    sessionUpdates: [],
    configUpdates: [],
  };
}

function initialModel(): WorkspaceViewModel {
  const enabled = { disabled: false, reason: null } as const;
  return {
    status: "ready",
    workspace,
    directoryList: commandResult(
      "/dirs",
      `Workspace directories:\n  ${currentFolder} (working directory)\n  ${sharedFolder}`,
    ),
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
  };
}

function WorkspacePlayground() {
  const overlay = useOverlayHost();
  const hostRef = useRef<DialogHostController | null>(null);
  const [model, setModel] = useState(initialModel);
  const [notice, setNotice] = useState("App-owned dialogs resolve locally through U4.");
  if (hostRef.current === null) {
    hostRef.current = new DialogHostController({
      overlay,
      capabilities: noOmpUi,
      answerExtensionUi: async () => {
        setNotice("Unexpected OMP dialog answer route.");
        throw new Error("App-owned workspace dialogs must not answer an OMP UI request.");
      },
      render: renderDialogRequest,
    });
  }
  const host = hostRef.current;
  useEffect(() => () => host.dispose(), [host]);

  const openInput = async (
    request: InputDialogRequest,
  ): Promise<DialogResultFor<InputDialogRequest> | null> => {
    try {
      return await host.open(request, { threadId, origin: "app" });
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "The dialog could not be opened.");
      return null;
    }
  };
  const openSelect = async (
    request: SelectDialogRequest,
  ): Promise<DialogResultFor<SelectDialogRequest> | null> => {
    try {
      return await host.open(request, { threadId, origin: "app" });
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "The dialog could not be opened.");
      return null;
    }
  };

  const actions: WorkspacePanelActions = {
    onRefresh: () => setNotice("Workspace state refreshed."),
    onAddDirectory: async () => {
      const result = await openInput({
        kind: "input",
        id: `app-d5-3-add-${crypto.randomUUID()}` as UiRequestId,
        title: "Add an existing workspace directory",
        placeholder: "/path/to/existing/folder",
      });
      if (result?.outcome === "answered") setNotice(`Ready to add ${result.response.value}`);
    },
    onRemoveDirectory: async () => {
      const confirmed = await host.confirm(
        {
          kind: "confirm",
          id: `app-d5-3-remove-${crypto.randomUUID()}` as UiRequestId,
          title: "Remove workspace directory?",
          message: `Remove ${sharedFolder} from this session's workspace? The folder and its files will remain unchanged.`,
        },
        { threadId, origin: "app" },
      );
      setNotice(confirmed ? `Ready to remove ${sharedFolder}` : "Directory removal cancelled.");
    },
    onMoveSession: async () => {
      const selected = await openSelect({
        kind: "select",
        id: `app-d5-3-move-${crypto.randomUUID()}` as UiRequestId,
        title: "Choose an existing folder",
        options: [sharedFolder, "Choose another existing folder…"],
      });
      if (selected?.outcome !== "answered") return;
      const selectedFolder = selected.response.value;
      if (selectedFolder === "Choose another existing folder…") {
        const input = await openInput({
          kind: "input",
          id: `app-d5-3-move-path-${crypto.randomUUID()}` as UiRequestId,
          title: "Move to an existing folder",
          placeholder: "/path/to/existing/folder",
        });
        if (input?.outcome === "answered") {
          setNotice(`Ready to move the session to ${input.response.value}`);
        }
        return;
      }
      setModel((current) => ({
        ...current,
        lastCommand: commandResult(`/move ${selectedFolder}`, `Moved to ${selectedFolder}.`),
        lastCommandLabel: "Move session",
      }));
      setNotice(`Ready to move the session to ${selectedFolder}`);
    },
    onManageSsh: async () => {
      const selected = await openSelect({
        kind: "select",
        id: `app-d5-3-ssh-${crypto.randomUUID()}` as UiRequestId,
        title: "SSH hosts",
        options: ["List hosts", "Add host", "Remove host", "Show help"],
      });
      if (selected?.outcome === "answered") setNotice(`Selected ${selected.response.value}`);
    },
    onWorktree: () => undefined,
  };

  return (
    <main
      className="min-h-screen bg-background text-foreground"
      data-testid="d5-3-workspace-playground"
    >
      <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-6 sm:px-6">
        <header className="border-border bg-card flex flex-wrap items-start justify-between gap-3 rounded-xl border p-4">
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              omp / D5
            </p>
            <h1 className="mt-1 text-xl font-semibold">Workspace controls</h1>
          </div>
          <p
            className="max-w-md text-sm text-muted-foreground"
            data-testid="workspace-notice"
            role="status"
          >
            {notice}
          </p>
        </header>
        <WorkspacePanelView model={model} actions={actions} />
      </div>
    </main>
  );
}

const root = document.getElementById("d5-3-workspace-playground-root");
if (!root) throw new Error("D5.3 workspace playground root is missing.");
createRoot(root).render(
  <OverlayHost>
    <WorkspacePlayground />
  </OverlayHost>,
);
