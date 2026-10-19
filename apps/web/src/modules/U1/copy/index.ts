import { messageIdentity, type OmpMessage } from "@omp-app/contracts";
import type { RuntimeMessageView } from "../../R0/runtime";
import type { RuntimeMessage, RuntimeSnapshot } from "../../R0/store";
import type { RawTranscriptContent, RawTranscriptPart, TranscriptRow } from "../model";

export type { RawTranscriptContent, RawTranscriptPart } from "../model";

/**
 * Raw parts use `tool-call` for both an assistant tool call and a persisted tool result. The source
 * field is always the exact omp value; callers that need a string representation of an object must
 * choose that explicitly rather than copying a rendered card.
 */

/**
 * Fidelity rules for this boundary:
 *
 * - Raw text and thinking parts retain their source strings, including Markdown punctuation and
 *   incomplete fences. Assistant copy exposes text blocks only, separates them with blank lines,
 *   and never reads rendered DOM.
 * - A tool call keeps the exact `rawBlock` when omp supplied one. When it did not, `source` remains
 *   the exact arguments object and `markdown`/`plainText` use deterministic JSON only as the
 *   documented string-copy fallback.
 * - Tool results keep the complete omp result message in `source`, including `details`, `isError`,
 *   and content blocks.
 * - Images keep their complete omp image object in `source`; URLs use Markdown image references,
 *   while inline bytes receive a text placeholder and are never embedded into copied text.
 * - Data already redacted by omp remains redacted. No reader-side secret/path redaction is added.
 */

/**
 * An input accepted by the raw reader. Runtime messages are the preferred input because they retain
 * the C0 key and the original OmpMessage. A TranscriptRow is also accepted when a domain row has
 * already attached its immutable raw source record.
 */
export type KeyedTranscriptMessage = {
  readonly key: string;
  readonly message: OmpMessage;
  readonly entryId?: string;
  readonly streamMessageId?: string;
};

export type TranscriptContentInput =
  | RuntimeMessage
  | RuntimeMessageView
  | TranscriptRow
  | RawTranscriptContent
  | OmpMessage
  | KeyedTranscriptMessage;
export type TranscriptContentManyInput = readonly TranscriptContentInput[] | RuntimeSnapshot;

type RawPartType = RawTranscriptPart["type"];

type BuiltPart = {
  readonly part: RawTranscriptPart;
  readonly markdown?: string;
  readonly plainText?: string;
};

type BuiltContent = {
  readonly parts: readonly BuiltPart[];
  readonly markdown: string;
  readonly plainText: string;
};

export interface CopyTextOptions {
  readonly includeReasoning?: boolean;
}

/** Returns copyable text without hidden reasoning unless the caller opts in explicitly. */
export function copyText(raw: RawTranscriptContent, options: CopyTextOptions = {}): string {
  return raw.parts
    .filter((part) => {
      if (part.type === "reasoning") return options.includeReasoning === true;
      return part.type !== "tool-call";
    })
    .map((part) =>
      part.type === "image"
        ? (part.markdown ?? part.plainText ?? "")
        : (part.plainText ?? part.markdown ?? ""),
    )
    .filter((text) => text.length > 0)
    .join("\n\n");
}

type CachedRaw = {
  readonly fingerprint: string;
  readonly raw: RawTranscriptContent;
};
type CachedObject = {
  readonly fingerprint: string;
  readonly fallbackKey: string;
  readonly raw: RawTranscriptContent;
};

const UNKNOWN_MESSAGE_KEY = "omp:unknown";
const MAX_IDENTITY_CACHE_ENTRIES = 128;

function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "key" in value &&
    typeof value.key === "string" &&
    "status" in value &&
    typeof value.status === "string" &&
    "message" in value &&
    isOmpMessage(value.message)
  );
}

function isRuntimeMessageView(value: unknown): value is RuntimeMessageView {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "record" in value &&
    isRuntimeMessage(value.record) &&
    "toolStates" in value &&
    Array.isArray(value.toolStates)
  );
}

function isKeyedTranscriptMessage(value: unknown): value is KeyedTranscriptMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "key" in value &&
    typeof value.key === "string" &&
    !("messageKey" in value) &&
    "message" in value &&
    isOmpMessage(value.message)
  );
}

function isTranscriptRow(value: unknown): value is TranscriptRow {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "key" in value &&
    typeof value.key === "string" &&
    "messageKey" in value &&
    typeof value.messageKey === "string" &&
    "kind" in value &&
    typeof value.kind === "string" &&
    "parts" in value &&
    Array.isArray(value.parts)
  );
}

function isRawTranscriptContent(value: unknown): value is RawTranscriptContent {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "messageKey" in value &&
    typeof value.messageKey === "string" &&
    "source" in value &&
    (value.source === "omp" || value.source === "derived" || value.source === "host") &&
    "markdown" in value &&
    typeof value.markdown === "string" &&
    "plainText" in value &&
    typeof value.plainText === "string" &&
    "parts" in value &&
    Array.isArray(value.parts)
  );
}

function isRuntimeSnapshot(value: unknown): value is RuntimeSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "messageOrder" in value &&
    Array.isArray(value.messageOrder) &&
    "messages" in value &&
    typeof value.messages === "object" &&
    value.messages !== null &&
    !Array.isArray(value.messages) &&
    "threadId" in value &&
    typeof value.threadId === "string"
  );
}

function isOmpMessage(value: unknown): value is OmpMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "role" in value &&
    typeof value.role === "string"
  );
}

function cloneAndFreeze<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value) as T;
  if (value instanceof Date) return new Date(value.getTime()) as T;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(cloneAndFreeze(item, seen));
    return Object.freeze(copy) as T;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = cloneAndFreeze(item, seen);
  }
  return Object.freeze(copy) as T;
}

/** Stable only for cache comparison; the returned source never comes from this serialization. */
function fingerprint(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? String(value) : `number:${String(value)}`;
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
      return "undefined";
    case "bigint":
      return `bigint:${String(value)}`;
    case "symbol":
      return `symbol:${String(value)}`;
    case "function":
      return "function";
    default:
      break;
  }
  if (typeof value !== "object" || value === null) return "unknown";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (Array.isArray(value)) return `[${value.map((item) => fingerprint(item, seen)).join(",")}]`;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value);
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${fingerprint(item, seen)}`)
      .join(",")}}`;
  }
  return "unknown";
}

function safeJson(value: unknown): string | undefined {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? encoded : undefined;
  } catch {
    return undefined;
  }
}

function messageKeyFor(message: OmpMessage, fallbackKey: string): string {
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    const role = typeof message.role === "string" ? message.role : "unknown";
    if (
      role === "toolResult" &&
      "toolCallId" in message &&
      typeof message.toolCallId === "string"
    ) {
      return `omp:${role}:${message.timestamp}:${message.toolCallId}`;
    }
    if ((role === "custom" || role === "hookMessage") && "customType" in message) {
      return `omp:${role}:${message.timestamp}:${String(message.customType)}`;
    }
    return `omp:${role}:${message.timestamp}`;
  }
  return fallbackKey;
}

function cacheKeyFor(message: OmpMessage, key: string, streamMessageId?: string): string {
  if (streamMessageId !== undefined && streamMessageId.length > 0) {
    return `stream:${streamMessageId}`;
  }
  const identity = messageIdentity(message);
  return identity === undefined ? `key:${key}` : `identity:${identity}`;
}

function rawPart(
  index: number,
  type: RawPartType,
  source: unknown,
  plainText?: string,
  markdown?: string,
): BuiltPart {
  const part = {
    index,
    type,
    source: cloneAndFreeze(source),
    ...(plainText === undefined ? {} : { plainText }),
    ...(markdown === undefined ? {} : { markdown }),
  } satisfies RawTranscriptPart;
  return { part: Object.freeze(part), plainText, markdown };
}

function joinWithNewline(parts: readonly BuiltPart[], key: "markdown" | "plainText"): string {
  let result = "";
  for (const part of parts) {
    const next = part[key] ?? "";
    if (!next) continue;
    if (result && !result.endsWith("\n") && !next.startsWith("\n")) result += "\n";
    result += next;
  }
  return result;
}

/**
 * A Markdown image whose destination is written between `<` and `>`, so spaces and parentheses in
 * the address survive. CommonMark allows no unescaped `<` or `>` and no line break in that form.
 */
function markdownImageReference(url: string): string {
  const safeUrl = url
    .replaceAll("\\", "\\\\")
    .replaceAll("<", "\\<")
    .replaceAll(">", "\\>")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  return `![](<${safeUrl}>)`;
}
function builtImagePart(index: number, source: unknown): BuiltPart {
  let reference: string | undefined;
  let mimeType: string | undefined;
  if (typeof source === "object" && source !== null && !Array.isArray(source)) {
    if ("url" in source && typeof source.url === "string" && source.url.length > 0) {
      reference = source.url;
    }
    if ("mimeType" in source && typeof source.mimeType === "string" && source.mimeType.length > 0) {
      mimeType = source.mimeType;
    }
  }
  const plainText = reference ?? `[image: ${mimeType ?? "image"}]`;
  const markdown = reference === undefined ? undefined : markdownImageReference(reference);
  return rawPart(index, "image", source, plainText, markdown);
}

function contentParts(content: unknown, startIndex: number): BuiltContent {
  if (typeof content === "string") {
    const built = rawPart(startIndex, "text", content, content, content);
    return { parts: [built], markdown: content, plainText: content };
  }
  if (!Array.isArray(content)) {
    const built = rawPart(startIndex, "notice", content);
    return { parts: [built], markdown: "", plainText: "" };
  }

  const parts: BuiltPart[] = [];
  for (const [offset, itemValue] of content.entries()) {
    const index = startIndex + offset;
    const item: unknown = itemValue;
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      !("type" in item) ||
      typeof item.type !== "string"
    ) {
      parts.push(rawPart(index, "notice", item));
      continue;
    }
    switch (item.type) {
      case "text": {
        const text = "text" in item && typeof item.text === "string" ? item.text : undefined;
        parts.push(
          text === undefined
            ? rawPart(index, "notice", item)
            : rawPart(index, "text", item, text, text),
        );
        break;
      }
      case "thinking": {
        const thinking =
          "thinking" in item && typeof item.thinking === "string" ? item.thinking : undefined;
        const narration = "narration" in item && item.narration === true;
        parts.push(
          thinking === undefined
            ? rawPart(index, "notice", item)
            : rawPart(index, narration ? "text" : "reasoning", item, thinking, thinking),
        );
        break;
      }
      case "redactedThinking":
        // This payload is opaque data, not reasoning text. Keep it only in the raw source record.
        parts.push(rawPart(index, "notice", item));
        break;
      case "image":
        parts.push(builtImagePart(index, item));
        break;
      case "toolCall": {
        const exactBlock =
          "rawBlock" in item && typeof item.rawBlock === "string" ? item.rawBlock : undefined;
        // `rawBlock` is omp's exact source when present. Arguments stay lossless in `source`; a
        // deterministic JSON rendering is only a text-copy fallback for wire records without it.
        const fallback =
          exactBlock === undefined && "arguments" in item ? safeJson(item.arguments) : undefined;
        parts.push(
          rawPart(index, "tool-call", item, fallback ?? exactBlock, exactBlock ?? fallback),
        );
        break;
      }
      default:
        parts.push(rawPart(index, "notice", item));
        break;
    }
  }
  return {
    parts,
    markdown: joinWithNewline(parts, "markdown"),
    plainText: joinWithNewline(parts, "plainText"),
  };
}
function assistantTextContent(content: unknown, startIndex: number): BuiltContent {
  const built = contentParts(content, startIndex);
  const textParts = built.parts.filter((part) => part.part.type === "text");
  return {
    parts: built.parts,
    markdown: textParts.map((part) => part.markdown ?? "").join("\n\n"),
    plainText: textParts.map((part) => part.plainText ?? "").join("\n\n"),
  };
}

function toolResultParts(
  message: Extract<OmpMessage, { role: "toolResult" }>,
  index: number,
): BuiltContent {
  const nested = contentParts(message.content, index + 1);
  const tool = rawPart(index, "tool-call", message);
  return {
    parts: [tool, ...nested.parts],
    markdown: nested.markdown,
    plainText: nested.plainText,
  };
}

function commandParts(
  message: Extract<OmpMessage, { role: "bashExecution" | "pythonExecution" }>,
  index: number,
): BuiltContent {
  const hasCommand = message.role === "bashExecution";
  const command = hasCommand ? message.command : message.code;
  const commandText = typeof command === "string" ? command : "";
  const output = typeof message.output === "string" ? message.output : "";
  const parts = [
    rawPart(index, hasCommand ? "command" : "code", message, commandText, commandText),
    rawPart(index + 1, "code", message, output, output),
  ];
  if (message.role === "bashExecution" && Array.isArray(message.images)) {
    for (const imageValue of message.images) {
      const imageIndex = index + parts.length;
      const image: unknown = imageValue;
      const isImage = typeof image === "object" && image !== null && !Array.isArray(image);
      parts.push(
        isImage ? builtImagePart(imageIndex, image) : rawPart(imageIndex, "notice", image),
      );
    }
  }
  return {
    parts,
    markdown: joinWithNewline(parts, "markdown"),
    plainText: joinWithNewline(parts, "plainText"),
  };
}

function fileMentionParts(
  message: Extract<OmpMessage, { role: "fileMention" }>,
  index: number,
): BuiltContent {
  if (!Array.isArray(message.files)) {
    const notice = rawPart(index, "notice", message);
    return { parts: [notice], markdown: "", plainText: "" };
  }
  const parts: BuiltPart[] = [];
  let nextIndex = index;
  for (const itemValue of message.files) {
    const itemIndex = nextIndex;
    const item: unknown = itemValue;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      parts.push(rawPart(itemIndex, "notice", item));
      nextIndex += 1;
      continue;
    }
    const content = "content" in item && typeof item.content === "string" ? item.content : "";
    parts.push(rawPart(itemIndex, "file", item, content, content));
    nextIndex += 1;
    const image = "image" in item ? item.image : undefined;
    if (typeof image === "object" && image !== null && !Array.isArray(image)) {
      parts.push(builtImagePart(nextIndex, image));
      nextIndex += 1;
    }
  }
  return {
    parts,
    markdown: joinWithNewline(parts, "markdown"),
    plainText: joinWithNewline(parts, "plainText"),
  };
}

function messageContent(message: OmpMessage): BuiltContent {
  switch (message.role) {
    case "assistant":
      return assistantTextContent(message.content, 0);
    case "user":
    case "developer":
    case "custom":
    case "hookMessage":
      return contentParts(message.content, 0);
    case "toolResult":
      return toolResultParts(message, 0);
    case "bashExecution":
    case "pythonExecution":
      return commandParts(message, 0);
    case "fileMention":
      return fileMentionParts(message, 0);
    case "branchSummary":
    case "compactionSummary": {
      const summary = typeof message.summary === "string" ? message.summary : "";
      const part = rawPart(0, "notice", message, summary, summary);
      return { parts: [part], markdown: summary, plainText: summary };
    }
    default: {
      const notice = rawPart(0, "notice", message);
      return { parts: [notice], markdown: "", plainText: "" };
    }
  }
}

function fallbackContent(key: string, source: unknown): RawTranscriptContent {
  const part = rawPart(0, "notice", source).part;
  return Object.freeze({
    messageKey: key,
    source: "derived",
    markdown: "",
    plainText: "",
    parts: Object.freeze([part]),
  });
}

function sourceForInput(
  input: TranscriptContentInput,
  fallbackKey?: string,
): {
  readonly key: string;
  readonly source: "omp" | "derived" | "host";
  readonly message?: OmpMessage;
  readonly raw?: RawTranscriptContent;
  readonly cacheKey: string;
} {
  if (isRawTranscriptContent(input)) {
    return {
      key: input.messageKey,
      source: input.source,
      raw: input,
      cacheKey: `raw:${input.messageKey}`,
    };
  }
  if (isRuntimeMessageView(input)) {
    return {
      key: input.record.key,
      source: "omp",
      message: input.record.message,
      cacheKey: cacheKeyFor(input.record.message, input.record.key, input.record.streamMessageId),
    };
  }
  if (isRuntimeMessage(input)) {
    return {
      key: input.key,
      source: "omp",
      message: input.message,
      cacheKey: cacheKeyFor(input.message, input.key, input.streamMessageId),
    };
  }
  if (isKeyedTranscriptMessage(input)) {
    return {
      key: input.key,
      source: "omp",
      message: input.message,
      cacheKey: cacheKeyFor(input.message, input.key, input.streamMessageId),
    };
  }
  if (isTranscriptRow(input)) {
    if (input.raw !== undefined && isRawTranscriptContent(input.raw)) {
      return {
        key: input.raw.messageKey,
        source: input.raw.source,
        raw: input.raw,
        cacheKey: `raw:${input.raw.messageKey}`,
      };
    }
    // ThreadMessageLike is already normalized for display. Without an attached raw source it must
    // not be treated as an omp message, even when its role/content happen to have similar fields.
    return {
      key: input.messageKey,
      source: input.source,
      cacheKey: `row:${input.messageKey}`,
    };
  }
  if (isOmpMessage(input)) {
    const key = messageKeyFor(input, fallbackKey ?? UNKNOWN_MESSAGE_KEY);
    return {
      key,
      source: "omp",
      message: input,
      cacheKey: cacheKeyFor(input, key),
    };
  }
  return { key: UNKNOWN_MESSAGE_KEY, source: "derived", cacheKey: "unknown" };
}

/**
 * Reads raw transcript source without consulting assistant-ui's rendered state. The instance keeps a
 * small identity cache so a stream-to-history key change can reuse the immutable raw part records;
 * static methods are provided for one-shot callers that do not need cross-call caching.
 */
export class TranscriptContentReader {
  private readonly objects = new WeakMap<object, CachedObject>();
  private readonly anonymousKeys = new WeakMap<object, string>();
  private readonly identities = new Map<string, CachedRaw>();
  private nextAnonymousKey = 0;

  public static read(input: TranscriptContentInput): RawTranscriptContent {
    return new TranscriptContentReader().read(input);
  }

  public static readMany(input: TranscriptContentManyInput): readonly RawTranscriptContent[] {
    return new TranscriptContentReader().readMany(input);
  }

  public read(input: TranscriptContentInput): RawTranscriptContent {
    return this.readWithFallback(input, this.fallbackKeyFor(input), true);
  }

  public readMany(input: TranscriptContentManyInput): readonly RawTranscriptContent[] {
    if (isRuntimeSnapshot(input)) {
      return Object.freeze(
        input.messageOrder.flatMap((key) => {
          const message = input.messages[key];
          return message === undefined ? [] : [this.read(message)];
        }),
      );
    }
    return Object.freeze(
      input.map((item, index) =>
        this.readWithFallback(item, this.fallbackKeyFor(item, index), true),
      ),
    );
  }

  private fallbackKeyFor(input: TranscriptContentInput, index?: number): string | undefined {
    if (!isOmpMessage(input)) return undefined;
    if (typeof input.timestamp === "number" && Number.isFinite(input.timestamp)) return undefined;
    if (index !== undefined) return `${UNKNOWN_MESSAGE_KEY}:${index}`;
    const existing = this.anonymousKeys.get(input);
    if (existing !== undefined) return existing;
    const generated = `${UNKNOWN_MESSAGE_KEY}:${this.nextAnonymousKey}`;
    this.nextAnonymousKey += 1;
    this.anonymousKeys.set(input, generated);
    return generated;
  }

  private readWithFallback(
    input: TranscriptContentInput,
    fallbackKey: string | undefined,
    cacheObject: boolean,
  ): RawTranscriptContent {
    if (cacheObject && typeof input === "object" && input !== null) {
      const cached = this.objects.get(input);
      if (
        cached !== undefined &&
        cached.fallbackKey === (fallbackKey ?? "") &&
        cached.fingerprint === fingerprint(input)
      ) {
        return cached.raw;
      }
    }

    const resolved = sourceForInput(input, fallbackKey);
    if (resolved.raw !== undefined) {
      const raw = cloneAndFreeze(resolved.raw);
      this.remember(
        input,
        resolved.cacheKey,
        fingerprint(resolved.raw),
        raw,
        fallbackKey,
        cacheObject,
      );
      return raw;
    }

    if (resolved.message === undefined) {
      const fallbackSource = isTranscriptRow(input)
        ? { type: "notice", reason: "raw transcript source unavailable" }
        : input;
      const raw = fallbackContent(resolved.key, fallbackSource);
      this.remember(
        input,
        resolved.cacheKey,
        fingerprint(fallbackSource),
        raw,
        fallbackKey,
        cacheObject,
      );
      return raw;
    }

    const sourceFingerprint = fingerprint(resolved.message);
    const previous = this.identities.get(resolved.cacheKey);
    if (previous?.fingerprint === sourceFingerprint) {
      const previousRaw = previous.raw;
      if (previousRaw.messageKey === resolved.key && previousRaw.source === resolved.source) {
        this.remember(
          input,
          resolved.cacheKey,
          sourceFingerprint,
          previousRaw,
          fallbackKey,
          cacheObject,
        );
        return previousRaw;
      }
      const remapped = Object.freeze({
        ...previousRaw,
        messageKey: resolved.key,
        source: resolved.source,
      });
      this.remember(
        input,
        resolved.cacheKey,
        sourceFingerprint,
        remapped,
        fallbackKey,
        cacheObject,
      );
      return remapped;
    }

    const built = messageContent(resolved.message);
    const raw = Object.freeze({
      messageKey: resolved.key,
      source: resolved.source,
      markdown: built.markdown,
      plainText: built.plainText,
      parts: Object.freeze(built.parts.map((value) => value.part)),
    });
    this.remember(input, resolved.cacheKey, sourceFingerprint, raw, fallbackKey, cacheObject);
    return raw;
  }

  private remember(
    input: TranscriptContentInput,
    cacheKey: string,
    sourceFingerprint: string,
    raw: RawTranscriptContent,
    fallbackKey: string | undefined,
    cacheObject: boolean,
  ): void {
    if (cacheObject && typeof input === "object" && input !== null) {
      this.objects.set(input, {
        fingerprint: fingerprint(input),
        fallbackKey: fallbackKey ?? "",
        raw,
      });
    }
    this.identities.delete(cacheKey);
    this.identities.set(cacheKey, { fingerprint: sourceFingerprint, raw });
    while (this.identities.size > MAX_IDENTITY_CACHE_ENTRIES) {
      const oldest = this.identities.keys().next().value;
      if (oldest === undefined) break;
      this.identities.delete(oldest);
    }
  }
}

/**
 * Returns one immutable raw part for a message. Part indexes are source-order indexes, so callers
 * can use the same index against a streaming or persisted read as long as omp kept the part order.
 */
export function readTranscriptPart(
  input: TranscriptContentInput,
  index: number,
  reader = new TranscriptContentReader(),
): RawTranscriptPart | undefined {
  if (!Number.isInteger(index) || index < 0) return undefined;
  return reader.read(input).parts[index];
}
