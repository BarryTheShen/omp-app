import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { FindCard } from "./find";
import { GlobCard } from "./glob";

afterEach(cleanup);

/**
 * `details` objects as omp v18.12.6 builds them, with the source line named next to each. Paths, counts and
 * scores are invented; the keys and their types are omp's.
 */

function toolProps(
  toolName: string,
  args: unknown,
  details: unknown,
  text: string,
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: `${toolName}-1`,
    toolName,
    args,
    argsText: JSON.stringify(args),
    result: { content: [{ type: "text", text }], details },
    status: { type: "complete" },
  } as unknown as ToolRendererProps;
}

/** `FindStats` (`packages/tui/src/tools/find.ts:72-97`): `errors` is gone; `failed` and `unanswered` replace it. */
function findStats(overrides: Record<string, unknown>) {
  return {
    listed: 40,
    requests: 4,
    failed: 0,
    unanswered: 0,
    judged: 30,
    filesRead: 6,
    fileBytes: 20_480,
    inputTokens: 5_000,
    outputTokens: 120,
    cost: 0.0042,
    apiMs: 2_100,
    windowsJudged: 9,
    windowsPruned: 3,
    mapCards: 2,
    failures: [] as string[],
    ...overrides,
  };
}

describe("find details as omp v18.12.6 builds them", () => {
  // `packages/coding-agent/src/tools/jfind/index.ts:138-181` builds the details and the text; `cascade.ts:357-359`
  // derives `coverage`: "complete" with no failed request, "unavailable" when every request failed, else "partial".
  const partialEmpty = {
    query: "retry budget",
    keywords: ["retry", "budget"],
    threshold: 0.4,
    hits: [],
    coverage: "partial",
    stats: findStats({ failed: 1, failures: ["sketches: 429 Too Many Requests"] }),
    elapsedMs: 3_200,
    cwd: "/work",
    scopePath: "src",
  };
  const args = { query: "retry budget", grep_keywords: ["retry", "budget"], path: "src" };
  const partialText =
    'no hits for "retry budget" in src (τ 0.40)\npartial: 1 of 4 judge requests failed; unjudged files may still match';

  test("a search that judged only part of the files does not say 'No matches.'", () => {
    render(<FindCard rendererProps={toolProps("find", args, partialEmpty, partialText)} />);
    expandToolCards();

    expect(screen.queryByText("No matches.")).toBeNull();
    expect(screen.getByTestId("t2-find-partial").textContent).toBe(
      "Partial: 1 of 4 judge requests failed; unjudged files may still match.",
    );
    expect(screen.getByText("No matches in the files omp judged.")).toBeTruthy();
  });

  test("a partial search with hits still says some requests failed", () => {
    const hit = {
      rel: "src/retry.ts",
      nameScore: 0.5,
      contentScore: 0.8,
      linesSeen: 40,
      truncated: false,
      ranges: [{ start: 1, end: 5, p: 0.7, snippet: "retry()" }],
    };
    render(
      <FindCard
        rendererProps={toolProps(
          "find",
          args,
          { ...partialEmpty, hits: [hit] },
          `1 hit(s) for "retry budget" in src (τ 0.40), strongest first\npartial: 1 of 4 judge requests failed; unjudged files may still match`,
        )}
      />,
    );
    expandToolCards();

    expect(screen.getByText("src/retry.ts")).toBeTruthy();
    expect(screen.getByTestId("t2-find-partial")).toBeTruthy();
  });

  test("a complete search with no hits keeps 'No matches.'", () => {
    render(
      <FindCard
        rendererProps={toolProps(
          "find",
          args,
          { ...partialEmpty, coverage: "complete", stats: findStats({}) },
          'no hits for "retry budget" in src (τ 0.40)',
        )}
      />,
    );
    expandToolCards();

    expect(screen.getByText("No matches.")).toBeTruthy();
    expect(screen.queryByTestId("t2-find-partial")).toBeNull();
  });
});

describe("glob details as omp v18.12.6 builds them", () => {
  // `packages/coding-agent/src/tools/glob.ts:304-352` (`timedOut`, and `truncated: true` from `forceTruncated`), :619-631
  // (the timeout path), :84-93 (the notice); `packages/tui/src/tools/glob.ts:38-41`.
  const args = { pattern: "**/*.ts", path: "src" };

  test("a scan that timed out with no matches is incomplete, not 'No matches.'", () => {
    render(
      <GlobCard
        rendererProps={toolProps(
          "glob",
          args,
          {
            scopePath: "src",
            fileCount: 0,
            files: [],
            truncated: true,
            timedOut: true,
            cwd: "/work",
          },
          "Glob timed out after 30s before finding any matches — the scan is incomplete, NOT proof of absence.",
        )}
      />,
    );
    expandToolCards();

    expect(screen.queryByText("No matches.")).toBeNull();
    expect(screen.getByTestId("t2-glob-timed-out").textContent).toBe(
      "The scan timed out before it finished: this list is incomplete and is not proof that nothing matches.",
    );
    expect(screen.queryByTestId("t2-glob-truncated")).toBeNull();
  });

  test("a scan that timed out after some matches says the list is incomplete", () => {
    render(
      <GlobCard
        rendererProps={toolProps(
          "glob",
          args,
          {
            scopePath: "src",
            fileCount: 2,
            files: ["src/a.ts", "src/b.ts"],
            truncated: true,
            timedOut: true,
            cwd: "/work",
          },
          "src/a.ts\nsrc/b.ts\n\nglob timed out after 30s; returning 2 partial matches — results are incomplete",
        )}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("link", { name: "src/a.ts" })).toBeTruthy();
    expect(screen.getByTestId("t2-glob-timed-out")).toBeTruthy();
    expect(screen.queryByTestId("t2-glob-truncated")).toBeNull();
  });
});
