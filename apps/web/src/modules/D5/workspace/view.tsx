import { Button } from "@/components/ui/button";
import type { WorkspaceActionName, WorkspacePanelActions, WorkspaceViewModel } from "./models";

export interface WorkspacePanelViewProps {
  readonly model: WorkspaceViewModel;
  readonly actions: WorkspacePanelActions;
}

const ACTIONS: readonly {
  readonly id: WorkspaceActionName;
  readonly label: string;
  readonly callback: keyof WorkspacePanelActions;
}[] = [
  { id: "add-directory", label: "Add directory", callback: "onAddDirectory" },
  { id: "remove-directory", label: "Remove directory", callback: "onRemoveDirectory" },
  { id: "move-session", label: "Move session", callback: "onMoveSession" },
  { id: "manage-ssh", label: "Manage SSH hosts", callback: "onManageSsh" },
  { id: "worktree", label: "Create or move to worktree", callback: "onWorktree" },
];
const BUSY_STATUS_TEXT: Record<WorkspaceActionName, string> = {
  refresh: "Refreshing the workspace…",
  "add-directory": "Adding a folder…",
  "remove-directory": "Removing a folder…",
  "move-session": "Moving the session…",
  "manage-ssh": "Managing SSH hosts…",
  worktree: "Setting up a worktree…",
};

function StatusText({ children }: { readonly children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

export function WorkspacePanelView({ model, actions }: WorkspacePanelViewProps) {
  const hasLastCommand = model.lastCommand !== null;

  return (
    <section
      aria-labelledby="workspace-panel-heading"
      className="min-w-0 space-y-4"
      data-testid="workspace-panel"
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="workspace-panel-heading" className="text-base font-semibold">
            Workspace
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Directories, session location, worktrees, and SSH hosts
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={actions.onRefresh}
          disabled={model.actions.refresh.disabled}
          title={model.actions.refresh.reason ?? undefined}
        >
          Refresh
        </Button>
      </header>

      {model.status === "loading" ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading workspace details…
        </p>
      ) : null}
      {model.status === "idle" ? (
        <StatusText>Refresh to load the active session&apos;s workspace.</StatusText>
      ) : null}
      {model.error ? (
        <p
          className="rounded-lg border border-danger/30 bg-danger-surface px-3 py-2 text-sm text-danger-surface-foreground"
          role="alert"
        >
          {model.error.message}
        </p>
      ) : null}

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <section
          aria-label="Current workspace"
          className="min-w-0 rounded-lg border border-border/70 p-3"
        >
          <h3 className="text-sm font-semibold">Current directory</h3>
          {model.workspace ? (
            <>
              <code className="mt-2 block min-w-0 break-all text-sm" data-testid="workspace-path">
                {model.workspace.folder}
              </code>
              <dl className="mt-3 grid min-w-0 gap-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Git branch</dt>
                  <dd className="break-all">
                    {model.workspace.git.branch ??
                      (model.workspace.git.repositoryRoot === null
                        ? "Not a Git repository"
                        : "Unavailable")}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Changed files</dt>
                  <dd>{model.workspace.git.dirtyFiles.length}</dd>
                </div>
              </dl>
            </>
          ) : (
            <StatusText>No workspace location has been loaded.</StatusText>
          )}
        </section>

        <section
          aria-label="Workspace directory list"
          className="min-w-0 rounded-lg border border-border/70 p-3"
        >
          <h3 className="text-sm font-semibold">Directories in this session</h3>
          {model.directoryList ? (
            model.directoryList.outputs.length > 0 ? (
              <div className="mt-2 min-w-0 space-y-2" data-testid="workspace-directory-output">
                {model.directoryList.outputs.map((output, index) => (
                  <pre
                    className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-xs"
                    key={output.emittedAt ?? index}
                  >
                    {output.text}
                  </pre>
                ))}
              </div>
            ) : (
              <StatusText>omp returned no directory-list output.</StatusText>
            )
          ) : (
            <StatusText>Refresh to request the directory list from omp.</StatusText>
          )}
        </section>
      </div>

      <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">Workspace actions</legend>
        {ACTIONS.map(({ id, label, callback }) => {
          const presentation = model.actions[id];
          const reasonShown =
            presentation.disabled && presentation.reason && model.busyAction === null;
          return (
            <div className="min-w-0" key={id}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={actions[callback]}
                disabled={presentation.disabled}
                aria-describedby={reasonShown ? `${id}-reason` : undefined}
                title={presentation.reason ?? undefined}
              >
                {label}
              </Button>
              {reasonShown ? (
                <p
                  className="mt-1 max-w-56 text-xs text-muted-foreground"
                  id={`${id}-reason`}
                  role="status"
                >
                  {presentation.reason}
                </p>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      {model.busyAction ? (
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {BUSY_STATUS_TEXT[model.busyAction]}
        </p>
      ) : null}

      {hasLastCommand ? (
        <section
          aria-label="Last workspace command"
          className="min-w-0 rounded-lg border border-border/70 p-3"
        >
          <h3 className="text-sm font-semibold">{model.lastCommandLabel}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {model.lastCommand?.status === "aborted" ? "Cancelled" : "Completed"}
          </p>
          {model.lastCommand?.outputs.map((output, index) => (
            <pre
              className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-xs"
              key={output.emittedAt ?? index}
            >
              {output.text}
            </pre>
          ))}
        </section>
      ) : null}
    </section>
  );
}
