import {
  type GitState as ContractGitState,
  type WorkspaceState as ContractWorkspaceState,
  FolderPath,
  GitStatePort,
  PathText,
  WorkspaceStatePort,
} from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import {
  type GitFileKind,
  type GitState as InternalGitState,
  type WorkspaceState as InternalWorkspaceState,
  readWorkspaceState,
} from "../git";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

function fileStatus(kind: GitFileKind): ContractGitState["dirtyFiles"][number]["status"] {
  if (kind === "unmerged") return "conflicted";
  if (kind === "modified" || kind === "added" || kind === "deleted" || kind === "renamed")
    return kind;
  if (kind === "copied") return "copied";
  if (kind === "untracked") return "untracked";
  return "unknown";
}

function emptyGitState(): ContractGitState {
  return {
    repositoryRoot: null,
    branch: null,
    head: null,
    detached: false,
    dirtyFiles: [],
    ahead: 0,
    behind: 0,
    worktrees: [],
    observedAt: new Date().toISOString(),
  };
}

function mapGitState(git: InternalGitState | null): ContractGitState {
  if (!git) return emptyGitState();
  return {
    repositoryRoot: git.root ? FolderPath.parse(git.root) : null,
    branch: git.branch.name,
    head: git.head,
    detached: git.branch.detached,
    dirtyFiles: git.files.map((file) => ({
      path: PathText.parse(file.path),
      status: fileStatus(file.kind),
      staged: file.staged,
      worktree: file.unstaged,
    })),
    ahead: git.ahead ?? 0,
    behind: git.behind ?? 0,
    worktrees: git.worktrees.map((worktree) => ({
      path: FolderPath.parse(worktree.path),
      head: worktree.head,
      branch: worktree.branch,
      detached: worktree.detached,
      bare: worktree.bare,
      locked: worktree.locked,
    })),
    observedAt: new Date().toISOString(),
  };
}

function mapWorkspaceState(state: InternalWorkspaceState, folder: string): ContractWorkspaceState {
  return {
    folder: FolderPath.parse(folder),
    additionalDirectories: [],
    git: mapGitState(state.git),
    observedAt: new Date().toISOString(),
  };
}

export function createWorkspaceStateRegistration(context: A1PortContext): PortRegistration {
  return createA1PortRegistration(
    WorkspaceStatePort,
    {
      read: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        const reader = context.readWorkspaceState ?? readWorkspaceState;
        const state = await reader(args.folder);
        return mapWorkspaceState(state, args.folder);
      },
    },
    context.publish,
  );
}

export function createGitStateRegistration(context: A1PortContext): PortRegistration {
  return createA1PortRegistration(
    GitStatePort,
    {
      read: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        const reader = context.readWorkspaceState ?? readWorkspaceState;
        const state = await reader(args.folder);
        return mapGitState(state.git);
      },
    },
    context.publish,
  );
}
