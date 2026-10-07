import type { EntryId, MessageKey, OmpMessage, OmpStreamMessageId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { RuntimeMessage, RuntimeSnapshot } from "../../../R0/store";
import {
  copyText,
  type RawTranscriptContent,
  readTranscriptPart,
  TranscriptContentReader,
} from "../../copy";

const messageKey = (value: string): MessageKey => value as MessageKey;
const entryId = (value: string): EntryId => value as EntryId;
const streamMessageId = (value: string): OmpStreamMessageId => value as OmpStreamMessageId;

type RuntimeOverrides = {
  readonly status?: RuntimeMessage["status"];
  readonly streamMessageId?: OmpStreamMessageId;
  readonly entryId?: EntryId;
  readonly parentId?: EntryId | null;
};

function runtimeMessage(
  key: string,
  message: OmpMessage,
  options: RuntimeOverrides = {},
): RuntimeMessage {
  return {
    key: messageKey(key),
    message,
    status: options.status ?? "persisted",
    ...(options.streamMessageId === undefined ? {} : { streamMessageId: options.streamMessageId }),
    ...(options.entryId === undefined ? {} : { entryId: options.entryId }),
    ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
  };
}

function assistantMessage(content: readonly unknown[], timestamp = 10): OmpMessage {
  return {
    role: "assistant",
    content: [...content] as never,
    api: "openai-completions",
    provider: "fake-provider",
    model: "fake-model",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  } as OmpMessage;
}

describe("TranscriptContentReader", () => {
  test("keeps exact text, thinking, tool block, and image source records in order", () => {
    const thinking = { type: "thinking", thinking: "private reasoning" };
    const image = {
      type: "image",
      data: "synthetic-image-data",
      mimeType: "image/png",
      url: "https://example.test/image.png",
    };
    const toolCall = {
      type: "toolCall",
      id: "call-1",
      name: "read",
      arguments: { path: "src/file.ts", lineEnd: 4 },
      rawBlock: '{"path":"src/file.ts","lineEnd":4}',
    };
    const message = assistantMessage([
      { type: "text", text: "before\n```ts\nconst x = 1;\n```\nafter" },
      thinking,
      toolCall,
      image,
    ]);
    const runtime = runtimeMessage("stream:proc:msg-1", message, {
      status: "streaming",
      streamMessageId: streamMessageId("msg-1"),
    });

    const raw = new TranscriptContentReader().read(runtime);

    expect(raw.messageKey).toBe("stream:proc:msg-1");
    expect(raw.markdown).toBe("before\n```ts\nconst x = 1;\n```\nafter");
    expect(raw.plainText).toBe(raw.markdown);
    expect(copyText(raw)).toBe(raw.markdown);
    expect(copyText(raw, { includeReasoning: true })).toBe(`${raw.markdown}\n\nprivate reasoning`);
    expect(raw.parts.map((part) => part.type)).toEqual(["text", "reasoning", "tool-call", "image"]);
    expect(raw.parts[0]?.source).toEqual({
      type: "text",
      text: "before\n```ts\nconst x = 1;\n```\nafter",
    });
    expect(raw.parts[1]?.source).toEqual(thinking);
    expect(raw.parts[2]).toMatchObject({
      source: toolCall,
      markdown: toolCall.rawBlock,
      plainText: toolCall.rawBlock,
    });
    expect(raw.parts[3]?.plainText).toBe(image.url);
    expect(raw.parts[3]?.markdown).toBe("![](https://example.test/image.png)");
    expect(raw.parts[3]?.source).not.toBe(image);
    expect(Object.isFrozen(raw)).toBe(true);
    expect(Object.isFrozen(raw.parts)).toBe(true);
    expect(Object.isFrozen(raw.parts[2]?.source)).toBe(true);
  });

  test("keeps tool result content and opaque details without flattening the result", () => {
    const result = {
      role: "toolResult",
      toolCallId: "call-result",
      toolName: "bash",
      content: [
        { type: "text", text: "output line 1\noutput line 2" },
        { type: "image", data: "result-image-data", mimeType: "image/png" },
      ],
      isError: true,
      timestamp: 11,
      details: { exitCode: 1, provider: "opaque" },
    } as unknown as OmpMessage;

    const raw = TranscriptContentReader.read(
      runtimeMessage("entry:thread:tool-result", result, {
        status: "persisted",
        entryId: entryId("tool-result"),
      }),
    );

    expect(raw.parts).toHaveLength(3);
    expect(raw.parts.map((part) => part.type)).toEqual(["tool-call", "text", "image"]);
    expect(raw.parts[0]?.source).toEqual(result);
    expect(raw.parts[0]?.source).not.toBe(result);
    expect(raw.parts[0]?.plainText).toBeUndefined();
    expect(raw.parts[1]?.index).toBe(1);
    expect(raw.parts[2]?.index).toBe(2);
    expect(raw.parts[1]?.plainText).toBe("output line 1\noutput line 2");
    expect(raw.parts[2]?.plainText).toBe("[image: image/png]");
    expect(readTranscriptPart(raw, 1)?.plainText).toBe("output line 1\noutput line 2");
    expect(readTranscriptPart(raw, 2)?.plainText).toBe("[image: image/png]");
    expect(raw.markdown).toBe("output line 1\noutput line 2");
    expect(raw.plainText).toBe("output line 1\noutput line 2\n[image: image/png]");
    expect(raw.parts[0]?.source).toMatchObject({
      details: { exitCode: 1, provider: "opaque" },
    });
  });

  test("uses a deterministic argument fallback only when omp omitted rawBlock", () => {
    const call = {
      type: "toolCall",
      id: "call-no-raw",
      name: "grep",
      arguments: { pattern: "needle", path: "src" },
    };
    const raw = TranscriptContentReader.read(
      runtimeMessage("entry:thread:call", assistantMessage([call])),
    );

    expect(raw.parts[0]?.source).toEqual(call);
    expect(raw.parts[0]?.plainText).toBe('{"pattern":"needle","path":"src"}');
    expect(raw.parts[0]?.markdown).toBe('{"pattern":"needle","path":"src"}');
  });

  test("remaps a stream key to its persisted history key while reusing immutable parts", () => {
    const message = assistantMessage([{ type: "text", text: "stable answer" }], 12);
    const reader = new TranscriptContentReader();
    const streaming = runtimeMessage("stream:proc:msg-2", message, {
      status: "ended",
      streamMessageId: streamMessageId("msg-2"),
    });
    const persisted = runtimeMessage("entry:thread:answer", message, {
      status: "persisted",
      streamMessageId: streamMessageId("msg-2"),
      entryId: entryId("answer"),
    });

    const before = reader.read(streaming);
    const after = reader.read(persisted);

    expect(before.messageKey).toBe("stream:proc:msg-2");
    expect(after.messageKey).toBe("entry:thread:answer");
    expect(after.parts).toBe(before.parts);
    expect(after.parts[0]).toBe(before.parts[0]);
    expect(after.markdown).toBe("stable answer");
    expect(after).not.toBe(before);
  });

  test("reads persisted history snapshots in messageOrder and keeps raw rows independent of disclosure", () => {
    const source: RawTranscriptContent = Object.freeze({
      messageKey: "entry:thread:raw",
      source: "omp",
      markdown: "**source** [link](https://example.test)",
      plainText: "source link",
      parts: Object.freeze([
        Object.freeze({
          index: 0,
          type: "text",
          source: { type: "text", text: "**source** [link](https://example.test)" },
          markdown: "**source** [link](https://example.test)",
          plainText: "source link",
        }),
      ]),
    });
    const row = {
      key: source.messageKey,
      messageKey: source.messageKey,
      kind: "message",
      parts: [],
      raw: source,
      source: "omp",
    } as const;
    const first = assistantMessage([{ type: "text", text: "first" }], 13);
    const second = assistantMessage([{ type: "text", text: "second" }], 14);
    const snapshot = {
      threadId: "thread-copy",
      messageOrder: ["entry:thread:first", "entry:thread:second"],
      messages: {
        "entry:thread:first": runtimeMessage("entry:thread:first", first),
        "entry:thread:second": runtimeMessage("entry:thread:second", second),
      },
    } as unknown as RuntimeSnapshot;
    const reader = new TranscriptContentReader();

    const rows = reader.readMany([row]);
    const history = reader.readMany(snapshot);

    expect(rows[0]).toEqual(source);
    expect(rows[0]).not.toBe(source);
    expect(history.map((item) => item.messageKey)).toEqual([
      "entry:thread:first",
      "entry:thread:second",
    ]);
    expect(history.map((item) => item.plainText)).toEqual(["first", "second"]);
    expect(rows[0]?.parts[0]?.markdown).toContain("**source**");
    expect(rows[0]?.parts[0]?.plainText).toBe("source link");
  });

  test("matches persisted messages after a reload by omp identity when stream ids are absent", () => {
    const message = assistantMessage([{ type: "text", text: "reloaded answer" }], 15);
    const reader = new TranscriptContentReader();
    const first = reader.read(runtimeMessage("entry:thread:first", message));
    const second = reader.read(runtimeMessage("entry:thread:second", message));

    expect(second.messageKey).toBe("entry:thread:second");
    expect(second.parts).toBe(first.parts);
    expect(second.parts[0]).toBe(first.parts[0]);
  });

  test("accepts a keyed omp message without requiring a synthetic assistant-ui message", () => {
    const message = assistantMessage([{ type: "text", text: "history source" }], 16);
    const raw = TranscriptContentReader.read({
      key: "entry:thread:keyed",
      message,
    });

    expect(raw.messageKey).toBe("entry:thread:keyed");
    expect(raw.source).toBe("omp");
    expect(raw.plainText).toBe("history source");
  });

  test("assigns distinct keys to source-less messages in a multi-message read", () => {
    const reader = new TranscriptContentReader();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "source-less answer" }],
    } as unknown as OmpMessage;

    const raw = reader.readMany([message, message]);

    expect(raw.map((item) => item.messageKey)).toEqual(["omp:unknown:0", "omp:unknown:1"]);
    expect(raw.map((item) => item.plainText)).toEqual(["source-less answer", "source-less answer"]);
  });

  test("never scrapes a converted message and returns a safe notice for malformed input", () => {
    const reader = new TranscriptContentReader();
    const malformed = reader.read({ nope: true } as never);

    expect(malformed.messageKey).toBe("omp:unknown");
    expect(malformed.source).toBe("derived");
    expect(malformed.parts[0]?.type).toBe("notice");
    expect(malformed.parts[0]?.source).toEqual({ nope: true });
    expect(readTranscriptPart(malformed, -1, reader)).toBeUndefined();
  });
});
