import { type OmpMessage, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { TranscriptContentReader } from "@/modules/U1/copy";
import {
  ExportRequestSchema,
  ExportResultSchema,
  parseShareImportResult,
  ShareImportResultDtoSchema,
  ShareResultSchema,
  ShareVisibilitySchema,
  TranscriptCopyResultSchema,
  TranscriptCopyTargetOptionSchema,
  TranscriptCopyTargetSchema,
} from "./index";

const threadId = ThreadId.parse("thread-d4-contract");

/** A bash execution as omp records it; U1's reader turns it into a command part and an output part. */
const bashExecution = {
  role: "bashExecution",
  command: "printf ok\n",
  output: "ok\n",
  cancelled: false,
  truncated: false,
  timestamp: 18,
} as unknown as OmpMessage;

describe("D4 transcript action contracts", () => {
  test("a whole bash command or its output is a copy target named by U1's reader output", () => {
    // The key and the part indexes come from U1.7's reader, not from values written here.
    const raw = TranscriptContentReader.read({ key: "entry:thread:bash", message: bashExecution });
    const [command, output] = raw.parts;
    expect(command?.type).toBe("command");
    expect(output?.type).toBe("code");
    expect(
      TranscriptCopyTargetSchema.safeParse({
        kind: "command",
        messageKey: raw.messageKey,
        partIndex: command?.index,
      }).success,
    ).toBe(true);
    expect(
      TranscriptCopyTargetSchema.safeParse({
        kind: "code",
        messageKey: raw.messageKey,
        partIndex: output?.index,
      }).success,
    ).toBe(true);
  });

  test("a fenced block inside a text part adds a block index or a range", () => {
    expect(
      TranscriptCopyTargetSchema.safeParse({
        kind: "code",
        messageKey: "entry:thread:message",
        partIndex: 3,
        blockIndex: 1,
      }).success,
    ).toBe(true);
    expect(
      TranscriptCopyTargetSchema.safeParse({
        kind: "command",
        messageKey: "entry:thread:message",
        partIndex: 3,
        range: { start: 1, end: 2 },
      }).success,
    ).toBe(true);
    expect(
      TranscriptCopyTargetSchema.safeParse({
        kind: "code",
        messageKey: "entry:thread:message",
        partIndex: 3,
        range: { start: 4, end: 2 },
      }).success,
    ).toBe(false);
    expect(
      TranscriptCopyTargetSchema.safeParse({
        kind: "command",
        messageKey: "entry:thread:message",
        partIndex: -1,
      }).success,
    ).toBe(false);
  });

  test("copy targets are persisted C0 message keys, and only a non-empty copy succeeds", () => {
    expect(
      TranscriptCopyTargetSchema.safeParse({ kind: "message", messageKey: "entry:thread:message" })
        .success,
    ).toBe(true);
    expect(
      TranscriptCopyTargetSchema.safeParse({ kind: "message", messageKey: "stream:proc:msg" })
        .success,
    ).toBe(false);
    expect(
      TranscriptCopyTargetSchema.safeParse({ kind: "message", messageKey: "entry:only" }).success,
    ).toBe(false);
    expect(
      TranscriptCopyTargetOptionSchema.safeParse({
        target: { kind: "code", messageKey: "entry:thread:message", partIndex: 0, blockIndex: 0 },
        label: "Code block",
        preview: "const answer = 42;",
      }).success,
    ).toBe(true);
    expect(TranscriptCopyResultSchema.safeParse({ chars: 0 }).success).toBe(false);
    expect(TranscriptCopyResultSchema.safeParse({ chars: -1 }).success).toBe(false);
  });
});

describe("D4 export contracts", () => {
  test("distinguishes transcript formats, HTML export, and session/all dumps", () => {
    expect(ExportRequestSchema.safeParse({ format: "markdown", threadId }).success).toBe(true);
    expect(ExportRequestSchema.safeParse({ format: "plain", threadId }).success).toBe(true);
    expect(ExportRequestSchema.safeParse({ format: "html", threadId }).success).toBe(true);
    expect(ExportRequestSchema.safeParse({ format: "dump", threadId, scope: "all" }).success).toBe(
      true,
    );
    expect(ExportRequestSchema.safeParse({ format: "dump", threadId }).success).toBe(false);
  });

  test("returns typed download, saved-path, and dump-report results", () => {
    expect(
      ExportRequestSchema.safeParse({
        format: "markdown",
        threadId,
        target: { kind: "message", messageKey: "entry:thread:message" },
      }).success,
    ).toBe(true);
    expect(
      ExportResultSchema.safeParse({
        kind: "download",
        format: "markdown",
        source: "transcript",
        download: {
          filename: "conversation.md",
          mediaType: "text/markdown",
          content: "# Conversation",
        },
      }).success,
    ).toBe(true);
    expect(
      ExportResultSchema.safeParse({
        kind: "path",
        format: "html",
        source: "omp",
        path: "exports/conversation.html",
      }).success,
    ).toBe(true);
    expect(
      ExportRequestSchema.safeParse({
        format: "html",
        threadId,
        outputPath: "../../../etc/cron.d/x",
      }).success,
    ).toBe(false);
    expect(
      ExportRequestSchema.safeParse({
        format: "html",
        threadId,
        outputPath: "x".repeat(4_097),
      }).success,
    ).toBe(false);
    expect(
      ExportResultSchema.safeParse({
        kind: "report",
        format: "dump",
        source: "omp",
        text: "Session report",
      }).success,
    ).toBe(true);
    // Nothing in this contract produces a redaction flag, so no result may carry one.
    expect(
      ExportResultSchema.safeParse({
        kind: "report",
        format: "dump",
        source: "omp",
        text: "Session report",
        redacted: true,
      }).success,
    ).toBe(false);
    expect(
      ExportResultSchema.safeParse({
        kind: "report",
        format: "markdown",
        source: "omp",
        text: "unexpected shape",
      }).success,
    ).toBe(false);
    expect(
      ExportResultSchema.safeParse({ outputs: [{ text: "unparsed command prose" }] }).success,
    ).toBe(false);
  });
});

describe("D4 share and import contracts", () => {
  test("models the fixed one-shot share result and no visibility choice", () => {
    expect(
      ShareResultSchema.safeParse({
        url: "https://share.example/session/opaque-id",
        gistUrl: "https://gist.github.com/example/123456",
        truncated: false,
      }).success,
    ).toBe(true);
    expect(
      ShareResultSchema.safeParse({
        url: "http://share.example/session/opaque-id",
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      ShareResultSchema.safeParse({
        url: "javascript:alert(1)",
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      ShareVisibilitySchema.safeParse({
        state: "unavailable",
        capability: "upstream.share-visibility",
        reason: "Share visibility is unavailable in this omp release.",
      }).success,
    ).toBe(true);
    expect(
      ShareVisibilitySchema.safeParse({
        state: "available",
        capability: "upstream.share-visibility",
        reason: "Share visibility is available.",
      }).success,
    ).toBe(false);
  });

  const realResult = {
    threadId,
    sessionFile: "/home/omp/sessions/example.jsonl",
    title: "Imported conversation",
    sourceKind: "omp-share",
    sourceShareUrl: "https://share.example/session/opaque-id",
    artifactStatus: "unavailable",
    artifactWarnings: ["Some shared attachments could not be imported."],
  };

  test("maps the real A1.12 result while omitting paths and source URLs", () => {
    const safeResult = parseShareImportResult(realResult);
    expect(ShareImportResultDtoSchema.safeParse(safeResult).success).toBe(true);
    expect(safeResult).not.toHaveProperty("sessionFile");
    expect(safeResult).not.toHaveProperty("sourceShareUrl");
    expect(safeResult.artifactWarnings).toEqual(realResult.artifactWarnings);
  });

  test("refuses a warning or a warning list beyond the limits A1.12's own schema sets", () => {
    expect(() =>
      parseShareImportResult({ ...realResult, artifactWarnings: ["x".repeat(513)] }),
    ).toThrow();
    expect(() =>
      parseShareImportResult({
        ...realResult,
        artifactWarnings: Array.from({ length: 33 }, () => "A warning."),
      }),
    ).toThrow();
  });
});
