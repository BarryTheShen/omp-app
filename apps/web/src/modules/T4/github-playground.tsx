import { createRoot } from "react-dom/client";
import "../../index.css";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { GITHUB_PUSH_RESULT, GITHUB_WATCH_RESULT } from "./fixtures/v18.9.1-results";
import { GithubCard } from "./github";

function props(
  toolCallId: string,
  result: unknown,
  status: unknown,
  args: Record<string, unknown>,
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId,
    toolName: "github",
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

function GithubPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t4-github-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-5xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">GitHub result cards</h1>
        <p className="text-muted-foreground text-sm">
          Source-shaped push and Actions watch results
        </p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-5xl flex-col gap-4 rounded-xl border p-4 shadow-xs sm:p-6">
        <GithubCard
          rendererProps={props(
            "github-push",
            GITHUB_PUSH_RESULT,
            { type: "complete" },
            { op: "pr_push", repo: "example/repository" },
          )}
        />
        <GithubCard
          rendererProps={props(
            "github-watch",
            GITHUB_WATCH_RESULT,
            { type: "running" },
            { op: "run_watch", repo: "example/repository", run: "4" },
          )}
        />
      </section>
    </main>
  );
}

const root = document.getElementById("t4-github-playground-root");
if (!root) throw new Error("T4 GitHub playground root is missing.");
createRoot(root).render(<GithubPlayground />);
