import { z } from "zod";
import { definePort } from "../../core/envelope";
import { FolderPath } from "../../core/ids";
import { PathText, Timestamp } from "./shared";

export const GitFileStatus = z.enum([
  "added",
  "copied",
  "deleted",
  "modified",
  "renamed",
  "untracked",
  "ignored",
  "conflicted",
  "unknown",
]);
export type GitFileStatus = z.infer<typeof GitFileStatus>;

export const GitDirtyFile = z.strictObject({
  path: PathText,
  status: GitFileStatus,
  staged: z.boolean(),
  worktree: z.boolean(),
});
export type GitDirtyFile = z.infer<typeof GitDirtyFile>;

export const GitWorktree = z.strictObject({
  path: FolderPath,
  head: z.string().min(1).nullable(),
  branch: z.string().min(1).nullable(),
  detached: z.boolean(),
  bare: z.boolean(),
  locked: z.boolean(),
});
export type GitWorktree = z.infer<typeof GitWorktree>;

/** Read-only result of git status, branch and worktree inspection. */
export const GitState = z.strictObject({
  repositoryRoot: FolderPath.nullable(),
  branch: z.string().min(1).nullable(),
  head: z.string().min(1).nullable(),
  detached: z.boolean(),
  dirtyFiles: z.array(GitDirtyFile),
  ahead: z.int().nonnegative(),
  behind: z.int().nonnegative(),
  worktrees: z.array(GitWorktree),
  observedAt: Timestamp,
});
export type GitState = z.infer<typeof GitState>;

export const WorkspaceReadArgs = z.strictObject({ folder: FolderPath });
export type WorkspaceReadArgs = z.infer<typeof WorkspaceReadArgs>;

/** Workspace roots are explicit; no file contents or git mutations belong to this port. */
export const WorkspaceState = z.strictObject({
  folder: FolderPath,
  additionalDirectories: z.array(FolderPath),
  git: GitState,
  observedAt: Timestamp,
});
export type WorkspaceState = z.infer<typeof WorkspaceState>;

export const WorkspaceStatePort = definePort({
  name: "A1.workspaceState",
  methods: {
    read: {
      args: WorkspaceReadArgs,
      result: WorkspaceState,
      capability: "host.workspace-state",
    },
  },
  events: {},
});

export const GitStatePort = definePort({
  name: "A1.gitState",
  methods: {
    read: {
      args: WorkspaceReadArgs,
      result: GitState,
      capability: "host.git-state",
    },
  },
  events: {},
});
