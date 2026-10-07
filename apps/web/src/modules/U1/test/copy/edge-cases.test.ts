import type { MessageKey, OmpMessage, OmpStreamMessageId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { RuntimeMessage } from "../../../R0/store";
import { copyText, TranscriptContentReader } from "../../copy";

const messageKey = (value: string): MessageKey => value as MessageKey;
const streamId = (value: string): OmpStreamMessageId => value as OmpStreamMessageId;

function runtimeMessage(
  key: string,
  message: OmpMessage,
  status: RuntimeMessage["status"] = "persisted",
  streamMessageId?: OmpStreamMessageId,
): RuntimeMessage {
  return {
    key: messageKey(key),
    message,
    status,
    ...(streamMessageId === undefined ? {} : { streamMessageId }),
  };
}

function assistantMessage(content: readonly unknown[], timestamp: number): OmpMessage {
  return {
    role: "assistant",
    content: [...content] as never,
    api: "openai-completions",
    provider: "fake-provider",
    model: "fake-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  } as OmpMessage;
}

describe("raw transcript copy edge cases", () => {
  test("refreshes immutable stream snapshots as the omp source grows", () => {
    const reader = new TranscriptContentReader();
    const id = streamId("msg-live");
    const first = runtimeMessage(
      "stream:proc:msg-live",
      assistantMessage([{ type: "text", text: "partial" }], 19),
      "streaming",
      id,
    );
    const update = runtimeMessage(
      "stream:proc:msg-live",
      assistantMessage([{ type: "text", text: "partial answer" }], 19),
      "streaming",
      id,
    );

    const before = reader.read(first);
    const after = reader.read(update);

    expect(before.plainText).toBe("partial");
    expect(after.plainText).toBe("partial answer");
    expect(after).not.toBe(before);
    expect(after.parts).not.toBe(before.parts);
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(after)).toBe(true);
  });

  test("copies Python code and bash execution images from their omp fields", () => {
    const reader = new TranscriptContentReader();
    const python = {
      role: "pythonExecution",
      code: "print('ok')\n",
      output: "ok\n",
      cancelled: false,
      truncated: false,
      timestamp: 17,
    } as unknown as OmpMessage;
    const pythonRaw = reader.read(runtimeMessage("entry:thread:python", python));

    expect(pythonRaw.parts.map((part) => part.type)).toEqual(["code", "code"]);
    expect(pythonRaw.parts[0]?.source).toEqual(python);
    expect(pythonRaw.markdown).toBe("print('ok')\nok\n");

    const image = {
      type: "image",
      data: "synthetic-image-data",
      mimeType: "image/png",
      url: "https://example.test/bash.png",
    };
    const bash = {
      role: "bashExecution",
      command: "printf ok",
      output: "ok\n",
      cancelled: false,
      truncated: false,
      timestamp: 18,
      images: [image],
    } as unknown as OmpMessage;
    const bashRaw = reader.read(runtimeMessage("entry:thread:bash", bash));

    expect(bashRaw.parts.map((part) => part.type)).toEqual(["command", "code", "image"]);
    expect(bashRaw.plainText).toBe("printf ok\nok\nhttps://example.test/bash.png");
    expect(bashRaw.markdown).toBe("printf ok\nok\n![](https://example.test/bash.png)");
    expect(bashRaw.parts[2]?.source).toEqual(image);
    expect(bashRaw.plainText).not.toContain(image.data);
  });

  test("separates assistant text blocks and excludes tool records from default copy", () => {
    const toolCall = {
      type: "toolCall",
      id: "call-copy",
      name: "read",
      arguments: { path: "src/file.ts" },
      rawBlock: '{"path":"src/file.ts"}',
    };
    const raw = new TranscriptContentReader().read(
      runtimeMessage(
        "entry:thread:blocks",
        assistantMessage(
          [
            { type: "text", text: "First block" },
            { type: "thinking", thinking: "private reasoning" },
            { type: "text", text: "Second block" },
            toolCall,
          ],
          24,
        ),
      ),
    );

    expect(raw.markdown).toBe("First block\n\nSecond block");
    expect(raw.plainText).toBe(raw.markdown);
    expect(copyText(raw)).toBe(raw.markdown);
    expect(copyText(raw, { includeReasoning: true })).toBe(
      "First block\n\nprivate reasoning\n\nSecond block",
    );
    expect(raw.parts[3]?.markdown).toBe(toolCall.rawBlock);
    expect(raw.markdown).not.toContain(toolCall.rawBlock);
  });

  test("keeps hidden reasoning out of default assistant copy", () => {
    const reader = new TranscriptContentReader();
    const raw = reader.read(
      runtimeMessage(
        "entry:thread:disclosed",
        assistantMessage(
          [
            { type: "thinking", thinking: "private reasoning" },
            { type: "text", text: "Full **source** answer with a [link](https://example.test)" },
          ],
          20,
        ),
      ),
    );
    const displayRow = {
      key: raw.messageKey,
      messageKey: raw.messageKey,
      kind: "message",
      parts: [{ type: "text", text: "Full …", status: "complete", markdown: true }],
      raw,
      source: "omp",
    } as const;

    const copied = reader.read(displayRow);

    expect(copied.markdown).toBe("Full **source** answer with a [link](https://example.test)");
    expect(copied.plainText).toBe(copied.markdown);
    expect(copyText(copied)).toBe(copied.markdown);
    expect(copyText(copied, { includeReasoning: true })).toBe(
      "private reasoning\n\nFull **source** answer with a [link](https://example.test)",
    );
    expect(copied.parts.map((part) => part.type)).toEqual(["reasoning", "text"]);
    expect(copied.parts[0]?.source).toMatchObject({
      type: "thinking",
      thinking: "private reasoning",
    });
  });

  test("keeps redacted thinking opaque and labels inline images in plain text", () => {
    const redacted = { type: "redactedThinking", data: "opaque-encrypted-payload" };
    const raw = new TranscriptContentReader().read(
      runtimeMessage(
        "entry:thread:redacted",
        assistantMessage(
          [
            { type: "text", text: "Answer" },
            redacted,
            { type: "image", data: "synthetic-inline-image", mimeType: "image/jpeg" },
          ],
          22,
        ),
      ),
    );

    expect(raw.markdown).toBe("Answer");
    expect(raw.plainText).toBe("Answer");
    expect(raw.parts.map((part) => part.type)).toEqual(["text", "notice", "image"]);
    expect(raw.parts[1]?.source).toEqual(redacted);
    expect(raw.parts[1]?.markdown).toBeUndefined();
    expect(raw.parts[1]?.plainText).toBeUndefined();
    expect(raw.parts[2]?.markdown).toBeUndefined();
    expect(raw.parts[2]?.plainText).toBe("[image: image/jpeg]");
    expect(copyText(raw)).toBe("Answer");
    expect(copyText(raw, { includeReasoning: true })).toBe("Answer");
  });

  test("rechecks an object cache hit when the source message changes in place", () => {
    const reader = new TranscriptContentReader();
    const message = assistantMessage([{ type: "text", text: "partial answer" }], 23);
    const input = runtimeMessage("entry:thread:mutable", message);
    const before = reader.read(input);
    const mutable = message as unknown as {
      content: Array<{ type: string; text: string }>;
    };
    const firstPart = mutable.content[0];
    if (!firstPart) throw new Error("The fixture has no text block.");
    firstPart.text = "partial answer, finished";

    const after = reader.read(input);

    expect(after.plainText).toBe("partial answer, finished");
    expect(after).not.toBe(before);
  });

  test("bounds the source identity cache while keeping returned snapshots intact", () => {
    const reader = new TranscriptContentReader();
    const firstMessage = assistantMessage([{ type: "text", text: "first" }], 30);
    const first = reader.read(runtimeMessage("entry:thread:first", firstMessage));

    for (let index = 0; index < 128; index += 1) {
      reader.read(
        runtimeMessage(
          `entry:thread:${index}`,
          assistantMessage([{ type: "text", text: `message ${index}` }], 100 + index),
        ),
      );
    }

    const reread = reader.read(runtimeMessage("entry:thread:first", firstMessage));
    expect(first.plainText).toBe("first");
    expect(reread.plainText).toBe("first");
    expect(reread.parts).not.toBe(first.parts);
  });

  test("preserves incomplete raw tool blocks and malformed open content safely", () => {
    const openToolCall = {
      type: "toolCall",
      id: "call-open",
      name: "read",
      arguments: {},
      rawBlock: '{"path": "',
    };
    const malformedThinking = { type: "thinking", thinking: 42, providerField: "preserved" };
    const raw = new TranscriptContentReader().read(
      runtimeMessage(
        "stream:proc:open",
        assistantMessage([{ type: "text", text: "before\n" }, openToolCall, malformedThinking], 21),
        "streaming",
        streamId("msg-open"),
      ),
    );

    expect(raw.parts.map((part) => part.type)).toEqual(["text", "tool-call", "notice"]);
    expect(raw.markdown).toBe("before\n");
    expect(raw.parts[1]).toMatchObject({
      source: openToolCall,
      markdown: openToolCall.rawBlock,
      plainText: openToolCall.rawBlock,
    });
    expect(raw.parts[2]).toMatchObject({ source: malformedThinking });
    expect(Object.isFrozen(raw.parts[2]?.source)).toBe(true);
  });

  test("does not copy a converted ThreadMessageLike when a row has no raw source", () => {
    const reader = new TranscriptContentReader();
    const convertedRow = {
      key: "entry:thread:converted",
      messageKey: "entry:thread:converted",
      kind: "message",
      parts: [],
      message: {
        id: "entry:thread:converted",
        role: "assistant",
        content: [{ type: "text", text: "rendered and sanitized" }],
      },
      source: "omp",
    };

    const raw = reader.read(convertedRow as never);

    expect(raw.messageKey).toBe("entry:thread:converted");
    expect(raw.markdown).toBe("");
    expect(raw.plainText).toBe("");
    expect(raw.parts[0]).toMatchObject({
      type: "notice",
      source: { type: "notice", reason: "raw transcript source unavailable" },
    });
  });
});
