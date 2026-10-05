import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  BrowserPreludeDetailsSchema,
  BrowserToolArgsSchema,
  GhToolArgsSchema,
  mapT4Failure,
  ReadUrlToolDetailsSchema,
  SearchRenderDetailsSchema,
  safeRetrievalUrl,
} from "./models";

describe("T4 normalized tool models", () => {
  test("accepts tolerant URL, browser, GitHub and search details", () => {
    expect(
      ReadUrlToolDetailsSchema.parse({
        kind: "url",
        url: "https://example.test/docs",
        finalUrl: "https://example.test/docs#section",
        contentType: "text/markdown",
        method: "GET",
        truncated: false,
        unknownBackendField: { retained: true },
      }),
    ).toMatchObject({ kind: "url", contentType: "text/markdown" });
    expect(
      BrowserToolArgsSchema.parse({ action: "run", code: "return 1", extra: true }),
    ).toMatchObject({
      action: "run",
    });
    expect(GhToolArgsSchema.parse({ op: "search_issues", query: "bug" })).toMatchObject({
      op: "search_issues",
    });
    expect(
      SearchRenderDetailsSchema.parse({
        query: "omp",
        response: { provider: "test", sources: [], answer: "No sources" },
      }),
    ).toMatchObject({ response: { sources: [] } });
    expect(
      BrowserPreludeDetailsSchema.parse({ action: "tabs", observations: [{ title: "tab" }] }),
    ).toMatchObject({
      action: "tabs",
    });
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
