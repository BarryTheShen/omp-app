import type { AppClient } from "@omp-app/client";
import {
  type CapabilityMap,
  FolderPath,
  type GithubReference,
  GithubRefsPort,
  type GitState,
  GitStatePort,
  type HostMetadata,
  HostMetadataPort,
  ThreadId,
} from "@omp-app/contracts";
import { createRoot } from "react-dom/client";
import "../../../index.css";
import type { RuntimeSnapshot, SessionInfoState } from "@/modules/R0/store";
import type { StatusRuntime } from "./controller";
import { StatusSegments } from "./status-segments";

const folder = FolderPath.parse("/work/app");
const threadId = ThreadId.parse("01903e7a-0000-7000-8000-000000000001");

const CAPABILITIES: CapabilityMap = {
  "host.metadata": { state: "available", via: "host" },
  "host.git-state": { state: "available", via: "host" },
  "host.github-refs": { state: "available", via: "host" },
  "omp.subagent-events": { state: "available", via: "omp" },
};

const HOST: HostMetadata = { hostname: "devbox", displayPath: "~/code/app" };

const GIT: GitState = {
  repositoryRoot: folder,
  branch: "main",
  head: "abcdef1234567890",
  detached: false,
  dirtyFiles: [],
  ahead: 0,
  behind: 0,
  worktrees: [],
  observedAt: "2026-10-09T14:03:00.000Z",
};

const PULL_REQUEST: GithubReference = {
  kind: "pull-request",
  number: 42,
  title: "Fix the build",
  body: "",
  url: "https://github.com/acme/app/pull/42",
  state: "open",
};

/** The port client the bar reads host, git and pull request data through. */
function playgroundClient(): Pick<AppClient, "port"> {
  const port = (target: unknown) => {
    if (target === HostMetadataPort) return { read: async () => HOST };
    if (target === GitStatePort) return { read: async () => GIT };
    if (target === GithubRefsPort)
      return { currentPullRequest: async () => ({ pullRequest: PULL_REQUEST }) };
    throw new Error("The status bar playground reads a port it does not know.");
  };
  return { port } as unknown as Pick<AppClient, "port">;
}

const SESSION: SessionInfoState = {
  model: null,
  thinkingLevel: null,
  sessionName: "Refactor auth",
  contextUsage: null,
  isCompacting: false,
  autoCompactionEnabled: null,
  tokensPerSecond: null,
  goal: null,
  revision: 0,
};

/** A runtime that is not streaming: the bar shows its clock and no active time. */
function playgroundRuntime(): StatusRuntime {
  const snapshot = { prompt: { streaming: false }, session: SESSION } as unknown as RuntimeSnapshot;
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
  };
}

const runtime = playgroundRuntime();
const client = playgroundClient();

function StatusBarPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="n1-4-status-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-4xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">Status bar</h1>
        <p className="text-muted-foreground text-sm">
          The folder, the git branch and the model. The server and the session are in the folder's
          tooltip.
        </p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-4xl flex-col gap-5 rounded-xl border p-4 shadow-xs sm:p-6">
        <StatusSegments
          capabilities={CAPABILITIES}
          client={client}
          folder={folder}
          reportFailure={() => undefined}
          roster={null}
          runtime={runtime}
          threadId={threadId}
        />
      </section>
    </main>
  );
}

createRoot(document.getElementById("n1-4-status-playground-root") as HTMLElement).render(
  <StatusBarPlayground />,
);
