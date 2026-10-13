import { describe, expect, test } from "vitest";
import { fileMentionFilesOf } from "./file-mention";

describe("fileMentionFilesOf (issue 1266)", () => {
  test("reads one row per file: its path, line count, image marker or skip reason", () => {
    expect(
      fileMentionFilesOf({
        role: "fileMention",
        timestamp: 1,
        files: [
          { path: "src/app.ts", content: "a\nb\n", lineCount: 2 },
          {
            path: "assets/logo.png",
            content: "",
            image: { type: "image", mimeType: "image/png", data: "AAAA" },
          },
          {
            path: "archive.zip",
            content: "(skipped auto-read: binary file, 2 KB)",
            byteSize: 2048,
            skippedReason: "binary",
          },
          {
            path: "huge.log",
            content: "(skipped auto-read: too large, 9 MB)",
            byteSize: 9_000_000,
            skippedReason: "tooLarge",
          },
        ],
      }),
    ).toEqual([
      { path: "src/app.ts", lineCount: 2 },
      { path: "assets/logo.png", image: true },
      { path: "archive.zip", skippedReason: "binary" },
      { path: "huge.log", skippedReason: "tooLarge" },
    ]);
  });

  test("drops an entry without a path and ignores a skip reason omp does not use", () => {
    expect(
      fileMentionFilesOf({
        files: [
          { path: "", content: "x", lineCount: 1 },
          { content: "x", lineCount: 1 },
          "not a file",
          { path: "notes.md", content: "x", lineCount: 1, skippedReason: "unknown-reason" },
        ],
      }),
    ).toEqual([{ path: "notes.md", lineCount: 1 }]);
  });

  test("gives no rows for a message without a file list", () => {
    expect(fileMentionFilesOf(undefined)).toEqual([]);
    expect(fileMentionFilesOf({ role: "fileMention", files: "notes.md" })).toEqual([]);
  });
});
