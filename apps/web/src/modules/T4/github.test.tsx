import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { GithubCard } from "./github";

afterEach(() => cleanup());

function props(overrides: Partial<ToolRendererProps> = {}): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: "github-call",
    toolName: "github",
    args: { op: "repo_view", repo: "owner/repo" },
    argsText: '{"op":"repo_view","repo":"owner/repo"}',
    status: { type: "complete" },
    ...overrides,
  } as unknown as ToolRendererProps;
}

describe("GithubCard", () => {
  test("renders repository, PR title/state, diff stats and compact file list", () => {
    render(
      <GithubCard
        rendererProps={props({
          result: {
            details: {
              op: "repo_view",
              repository: "owner/repo",
              pullRequest: { number: 42, title: "Improve card", state: "open" },
              diff: {
                additions: 12,
                deletions: 3,
                changedFiles: 2,
                files: [
                  { path: "src/card.tsx", status: "modified" },
                  { path: "src/card.test.tsx", status: "added" },
                ],
              },
            },
          },
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByTestId("t4-github-header").textContent).toContain("owner/repo");
    expect(screen.getByTestId("t4-github-pr").textContent).toContain("Improve card");
    expect(screen.getByTestId("t4-github-pr").textContent).toContain("+12");
    expect(screen.getByTestId("t4-github-files").textContent).toContain("src/card.tsx");
  });

  test("renders search rows, checkout/push metadata, Actions jobs and failed log tails", () => {
    render(
      <GithubCard
        rendererProps={props({
          args: { op: "run_watch", repo: "owner/repo", query: "bug" },
          result: {
            details: {
              op: "run_watch",
              repository: "owner/repo",
              results: [
                { title: "Issue result", repository: "owner/repo", snippet: "untrusted text" },
              ],
              worktree: { path: "feature-worktree" },
              remote: { name: "origin" },
              run: { name: "CI", status: "completed", conclusion: "failure" },
              jobs: [{ name: "test", status: "completed", conclusion: "failure" }],
              failedLogTail: "assertion failed",
              sourceLinks: ["https://github.com/owner/repo/actions/1", "javascript:alert(1)"],
            },
          },
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByTestId("t4-github-search-results").textContent).toContain("Issue result");
    expect(screen.getByTestId("t4-github-checkout-push").textContent).toContain("feature-worktree");
    expect(screen.getByTestId("t4-github-actions").textContent).toContain("CI");
    expect(screen.getByTestId("t4-github-failed-log").textContent).toContain("assertion failed");
    expect(screen.getByTestId("t4-github-source-links").querySelectorAll("a")).toHaveLength(1);
  });

  test("keeps raw details behind U3 disclosure and maps failed/cancelled states", () => {
    render(
      <GithubCard
        rendererProps={props({
          status: { type: "running" },
          result: {
            details: {
              op: "pr_push",
              status: "failed",
              error: "Push failed",
              failedLogTail: "remote rejected",
              privateField: "raw",
            },
          },
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("alert").textContent).toContain("Push failed: remote rejected");
    expect(screen.getByTestId("t4-github-raw-details").querySelector("summary")?.textContent).toBe(
      "Raw details",
    );
    expect(screen.queryByText("privateField")).toBeNull();
  });
  test("reports file overflow instead of silently cutting a long list", () => {
    const files = Array.from({ length: 129 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      status: "modified",
    }));
    render(
      <GithubCard
        rendererProps={props({
          result: {
            details: {
              op: "repo_view",
              pullRequest: { title: "Large diff", state: "open" },
              diff: { files },
            },
          },
        })}
      />,
    );
    expandToolCards();
    expect(screen.getByTestId("t4-github-files").textContent).toContain("+1 more");
  });
});
