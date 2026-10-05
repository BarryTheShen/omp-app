import { createRoot } from "react-dom/client";
import "../../index.css";
import type { ToolRendererProps } from "../U3/tool-card/contract";
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
        <h1 className="text-lg font-semibold tracking-tight">T4.4 GitHub card</h1>
        <p className="text-muted-foreground text-sm">
          Repository, pull request, search and Actions watch results
        </p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-5xl flex-col gap-4 rounded-xl border p-4 shadow-xs sm:p-6">
        <GithubCard
          rendererProps={props(
            "github-pr",
            {
              details: {
                op: "repo_view",
                repository: "owner/repo",
                branch: "feature/card",
                pullRequest: { number: 42, title: "Improve GitHub card", state: "open" },
                diff: {
                  additions: 18,
                  deletions: 4,
                  changedFiles: 3,
                  files: [
                    { path: "src/github.tsx", status: "modified" },
                    { path: "src/github.test.tsx", status: "added" },
                  ],
                },
                sourceLinks: ["https://github.com/owner/repo/pull/42"],
              },
            },
            { type: "complete" },
            { op: "repo_view", repo: "owner/repo", pr: 42 },
          )}
        />
        <GithubCard
          rendererProps={props(
            "github-watch",
            {
              details: {
                op: "run_watch",
                repository: "owner/repo",
                run: { name: "CI", status: "in_progress" },
                jobs: [{ name: "tests", status: "running" }],
                sourceLinks: ["https://github.com/owner/repo/actions/4"],
              },
            },
            { type: "running" },
            { op: "run_watch", repo: "owner/repo", run: "4" },
          )}
        />
        <GithubCard
          rendererProps={props(
            "github-search",
            {
              details: {
                op: "search_issues",
                repository: "owner/repo",
                results: [
                  {
                    title: "A search result",
                    repository: "owner/repo",
                    snippet: "Untrusted search text",
                  },
                  { title: "Another result", repository: "owner/other", snippet: "More text" },
                ],
              },
            },
            { type: "complete" },
            { op: "search_issues", query: "card" },
          )}
        />
        <GithubCard
          rendererProps={props(
            "github-failure",
            {
              details: {
                op: "pr_push",
                repository: "owner/repo",
                status: "failed",
                error: "Push failed",
                failedLogTail: "remote rejected",
              },
            },
            { type: "complete" },
            { op: "pr_push", repo: "owner/repo", branch: "feature/card" },
          )}
        />
      </section>
    </main>
  );
}

const root = document.getElementById("t4-github-playground-root");
if (!root) throw new Error("T4.4 GitHub playground root is missing.");
createRoot(root).render(<GithubPlayground />);
