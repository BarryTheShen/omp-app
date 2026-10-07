import { describe, expect, test } from "vitest";
import { splitToolResult } from "./result";

describe("splitToolResult", () => {
  test("splits omp's envelope into the joined text and the details, as a real read result has it", () => {
    const split = splitToolResult({
      content: [
        { type: "text", text: "model_cache (36 rows)" },
        { type: "text", text: "second part" },
      ],
      details: {
        resolvedPath: "/home/user/.omp/agent/models.db",
        meta: { source: { type: "file" } },
      },
    });
    expect(split).toEqual({
      text: "model_cache (36 rows)\nsecond part",
      details: {
        resolvedPath: "/home/user/.omp/agent/models.db",
        meta: { source: { type: "file" } },
      },
      isEnvelope: true,
    });
  });

  test("an envelope without details, or with only images in content, has no details and no text", () => {
    expect(splitToolResult({ content: [{ type: "text", text: "done" }] })).toEqual({
      text: "done",
      details: undefined,
      isEnvelope: true,
    });
    expect(
      splitToolResult({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }),
    ).toEqual({
      text: "",
      details: undefined,
      isEnvelope: true,
    });
  });

  test("a string result is text; anything that is not an envelope has neither text nor details", () => {
    expect(splitToolResult("plain output")).toEqual({
      text: "plain output",
      details: undefined,
      isEnvelope: false,
    });
    // A bare object that is not omp's envelope is not details: no card may guess that it is.
    expect(splitToolResult({ kind: "file", displayTarget: "a.ts" })).toEqual({
      text: "",
      details: undefined,
      isEnvelope: false,
    });
    for (const value of [undefined, null, 7, [], true]) {
      expect(splitToolResult(value).isEnvelope).toBe(false);
    }
  });
});
