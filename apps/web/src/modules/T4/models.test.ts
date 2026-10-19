import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { BROWSER_RESULT, GITHUB_PUSH_RESULT, SEARCH_RESULT } from "./fixtures/v18.9.1-results";
import {
  BrowserPreludeDetailsSchema,
  BrowserToolArgsSchema,
  GhToolArgsSchema,
  GhToolDetailsSchema,
  mapT4Failure,
  ReadUrlToolDetailsSchema,
  SearchRenderDetailsSchema,
  safeRetrievalUrl,
  searchAuthLabel,
  searchProviderLabel,
} from "./models";

describe("T4 normalized tool models", () => {
  test("parses source-derived v18.9.1 result details", () => {
    expect(
      ReadUrlToolDetailsSchema.parse({
        kind: "url",
        url: "https://example.test/docs",
        contentType: "text/markdown",
        method: "GET",
        truncated: false,
      }),
    ).toMatchObject({ kind: "url" });
    expect(
      BrowserToolArgsSchema.parse({ action: "targets", app: { target: "docs" } }),
    ).toMatchObject({
      action: "targets",
    });
    expect(BrowserPreludeDetailsSchema.parse(BROWSER_RESULT.details)).toMatchObject({
      value: "Get started with Bun",
      screenshots: [{ dest: "<TMP>/browser-screenshot.png", mimeType: "image/png", bytes: 2048 }],
    });
    expect(GhToolArgsSchema.parse({ op: "pr_push", branch: "feature/t4-results" })).toMatchObject({
      op: "pr_push",
    });
    expect(GhToolDetailsSchema.parse(GITHUB_PUSH_RESULT.details)).toMatchObject({
      branch: "feature/t4-results",
      remote: "origin",
      remoteBranch: "feature/t4-results",
    });
    expect(SearchRenderDetailsSchema.parse(SEARCH_RESULT.details)).toMatchObject({
      response: { provider: "perplexity", usage: { totalTokens: 560, searchRequests: 2 } },
    });
  });

  test("uses readable labels for provider and authentication ids", () => {
    expect(searchProviderLabel("exa")).toBe("Exa");
    expect(searchProviderLabel("perplexity")).toBe("Perplexity");
    expect(searchProviderLabel("unknown-provider")).toBe("Web search");
    expect(searchAuthLabel("api_key")).toBe("API");
    expect(searchAuthLabel("oauth")).toBe("OAuth");
    expect(searchAuthLabel("anonymous")).toBe("Anonymous");
    expect(searchAuthLabel("unknown-auth")).toBe("Authentication");
  });

  test("accepts retrieval links only and does not invent citations", () => {
    expect(safeRetrievalUrl("https://example.test/a")).toBe("https://example.test/a");
    expect(safeRetrievalUrl("http://example.test")).toBe("http://example.test/");
    expect(safeRetrievalUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeRetrievalUrl("answer prose without a URL")).toBeUndefined();
  });

  test("preserves typed AppFailures and hides unknown failure details", () => {
    const typed = new AppFailure({ code: "permission", message: "denied", retryable: false });
    expect(mapT4Failure(typed, "fallback")).toBe(typed);
    const mapped = mapT4Failure(new Error("private provider detail"), "Web tool failed");
    expect(mapped.appError).toEqual({
      code: "internal",
      message: "Web tool failed",
      retryable: false,
    });
    expect(mapped.appError.message).not.toContain("private provider detail");
  });
});
