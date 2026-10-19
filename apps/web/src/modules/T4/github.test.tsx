import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { GITHUB_CHECKOUT_RESULT } from "./fixtures/scripted";
import {
  GITHUB_CANCELLED_RESULT,
  GITHUB_PUSH_RESULT,
  GITHUB_SEARCH_RESULT,
  GITHUB_WATCH_RESULT,
} from "./fixtures/v18.9.1-results";
import { GithubCard } from "./github";

afterEach(() => cleanup());

function props(result: unknown, args: unknown = { op: "pr_push", repo: "owner/repo" }) {
  return {
    type: "tool-call",
    toolCallId: "github-call",
    toolName: "github",
    args,
    argsText: JSON.stringify(args),
    status: { type: "complete" },
    result,
  } as unknown as ToolRendererProps;
}

describe("GithubCard", () => {
  test("renders source-shaped push output and readable operation tooltip", () => {
    render(<GithubCard rendererProps={props(GITHUB_PUSH_RESULT)} />);
    expandToolCards();

    expect(screen.getByTestId("t4-github-header").textContent).toContain("owner/repo");
    expect(screen.getByTitle("GitHub operation: Push pull request branch")).toBeTruthy();
    expect(screen.getByTestId("t4-github-result").textContent).toContain(
      "Pushed feature/t4-results to origin:feature/t4-results.",
    );
    expect(screen.getByTestId("t4-github-checkout-push").textContent).toContain("Remote: origin");
    expect(screen.getByTestId("t4-github-checkout-push").textContent).toContain(
      "Remote branch: feature/t4-results",
    );
    expect(screen.getByRole("link", { name: "Open GitHub result" }).getAttribute("href")).toBe(
      "https://github.com/example/repository/pull/42",
    );
  });
  test("renders the scripted checkout operation and both checkout titles", () => {
    render(
      <GithubCard
        rendererProps={props(GITHUB_CHECKOUT_RESULT.result, GITHUB_CHECKOUT_RESULT.args)}
      />,
    );
    expandToolCards();

    expect(screen.getByTitle("GitHub operation: Check out pull request")).toBeTruthy();
    expect(screen.getByText("Pull request #42")).toBeTruthy();
    expect(screen.getByText("Pull request checkout")).toBeTruthy();
  });

  test("rejects an object remote because omp sends a remote name string", () => {
    render(
      <GithubCard
        rendererProps={props({
          content: [{ type: "text", text: "Push completed." }],
          details: { branch: "feature/test", remote: { name: "origin" } },
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("button", { name: "github: Error" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("GitHub details were malformed");
  });

  test("renders GitHub search text when the result has no structured search rows", () => {
    render(
      <GithubCard
        rendererProps={props(GITHUB_SEARCH_RESULT, {
          op: "search_issues",
          repo: "example/repository",
          query: "rules",
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByTitle("GitHub operation: Search issues")).toBeTruthy();
    expect(screen.getByTestId("t4-github-result").textContent).toContain("#42 Add rule panel");
  });

  test("shows the Actions watch heading for a source-shaped watch result", () => {
    render(
      <GithubCard
        rendererProps={props(GITHUB_WATCH_RESULT, {
          op: "run_watch",
          repo: "example/repository",
          run: "4",
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("heading", { name: "Actions watch" })).toBeTruthy();
    expect(screen.getByTitle("GitHub operation: Watch GitHub Actions")).toBeTruthy();
  });

  test("uses the GitHub operation failure fallback when a failed result has no text", () => {
    render(
      <GithubCard
        rendererProps={props({
          content: [],
          details: { repo: "example/repository", status: "failed" },
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("alert").textContent).toContain("GitHub operation failed.");
  });

  test("surfaces a cancelled Actions result with the cancellation reason", () => {
    render(
      <GithubCard
        rendererProps={props(GITHUB_CANCELLED_RESULT, {
          op: "run_watch",
          repo: "example/repository",
          run: "4",
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("button", { name: "github: Cancelled" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("GitHub operation cancelled.");
  });
});
