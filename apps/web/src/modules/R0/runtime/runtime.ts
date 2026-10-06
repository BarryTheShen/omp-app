import type {
  AppendMessage,
  AssistantRuntime,
  ExternalStoreAdapter,
  MessagePartStreamStatus,
  MessageStatus,
  ThreadMessageLike,
} from "@assistant-ui/react";
import { useExternalMessageConverter, useExternalStoreRuntime } from "@assistant-ui/react";
import type {
  AttachmentRef,
  CapabilityKey,
  CapabilityMap,
  OmpCommand,
  OmpMessage,
  OmpWire,
  PortCallOptions,
  RpcSessionSend,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type {
  OmpRuntimeStore,
  RuntimeMessage,
  RuntimeSnapshot,
  ToolCallState,
} from "../store/store";

export type PromptMode = "prompt" | "bash" | "python";
export type PromptDelivery = "new" | "steer" | "followUp";

type AbortSignalLike = NonNullable<PortCallOptions["signal"]>;

/** The application-level send intent. The thread id comes from the runtime's store. */
export interface PromptIntent {
  readonly mode: PromptMode;
  readonly text: string;
  readonly images?: readonly OmpWire.ImageContent[];
  /** Durable refs stay in the intent for U2 draft recovery; omp's released prompt wire has no ref field. */
  readonly attachmentRefs?: readonly AttachmentRef[];
  readonly delivery: PromptDelivery;
  readonly signal?: AbortSignalLike;
}

export interface OmpRuntimeOptions {
  readonly store: OmpRuntimeStore;
  readonly send: RpcSessionSend;
  readonly capabilities?: CapabilityMap;
  /** R0.2 supplies history refetch without making R0.3 depend on its implementation. */
  readonly onRefetchThread?: () => Promise<void>;
}

/** A stable external-store item; only the affected item is replaced when a tool changes. */
export interface RuntimeMessageView {
  readonly record: RuntimeMessage;
  readonly toolStates: readonly RuntimeToolStateReference[];
  /** Assistant entry keys in this contiguous assistant/tool turn, for reload/edit mapping. */
  readonly joinedAssistantEntryIds?: readonly string[];
  /** Whether a tool result has a matching assistant tool call in this turn. */
  readonly toolResultMatched?: boolean;
}

export interface RuntimeToolStateReference {
  readonly toolCallId: string;
  readonly state: ToolCallState | undefined;
}

const EMPTY_CAPABILITIES: CapabilityMap = Object.freeze({});
const EMPTY_MESSAGE_VIEWS: readonly RuntimeMessageView[] = Object.freeze([]);
const FALLBACK_TEXT = "Unable to render this omp message.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? encoded : "{}";
  } catch {
    return "{}";
  }
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function imageSource(data: unknown, url: unknown, mimeType: unknown): string | undefined {
  const urlText = nonEmptyString(url);
  if (urlText) return urlText;
  const dataText = nonEmptyString(data);
  if (!dataText) return undefined;
  if (
    dataText.startsWith("data:") ||
    dataText.startsWith("http://") ||
    dataText.startsWith("https://")
  ) {
    return dataText;
  }
  const mime = nonEmptyString(mimeType) ?? "application/octet-stream";
  return `data:${mime};base64,${dataText}`;
}

function messageIdFor(record: RuntimeMessage | undefined, index: number): string {
  const key = record?.key;
  return typeof key === "string" && key.length > 0 ? key : `omp-message-${index}`;
}

function toolCallIds(message: unknown): readonly string[] {
  const ids: string[] = [];
  const add = (value: unknown): void => {
    const id = nonEmptyString(value);
    if (id && !ids.includes(id)) ids.push(id);
  };
  if (!isRecord(message)) return ids;
  if (message.role === "toolResult") {
    add(message.toolCallId);
    return ids;
  }
  if (message.role !== "assistant" || !Array.isArray(message.content)) return ids;
  for (const part of message.content) {
    if (isRecord(part) && part.type === "toolCall") add(part.id);
  }
  return ids;
}
function stateFor(
  toolStates: readonly RuntimeToolStateReference[],
  toolCallId: string,
): ToolCallState | undefined {
  return toolStates.find((reference) => isRecord(reference) && reference.toolCallId === toolCallId)
    ?.state;
}

function streamStatus(runtime: RuntimeMessage | undefined): MessagePartStreamStatus {
  if (runtime?.status === "streaming") return { type: "running" };
  if (runtime?.interrupted === true) return { type: "incomplete", reason: "cancelled" };
  return { type: "complete" };
}

function messageStatus(runtime: RuntimeMessage | undefined, message: unknown): MessageStatus {
  if (runtime?.status === "streaming") return { type: "running" };
  if (runtime?.interrupted === true || (isRecord(message) && message.stopReason === "aborted")) {
    return { type: "incomplete", reason: "cancelled" };
  }
  if (isRecord(message) && message.stopReason === "error") {
    return { type: "incomplete", reason: "error" };
  }
  if (isRecord(message) && message.role === "assistant" && message.stopReason === "length") {
    return { type: "incomplete", reason: "length" };
  }
  return {
    type: "complete",
    reason: isRecord(message) && message.stopReason === "stop" ? "stop" : "unknown",
  };
}

function textPart(text: string, status?: MessagePartStreamStatus): Record<string, unknown> {
  return { type: "text", text, ...(status ? { status } : {}) };
}

function imagePart(part: Record<string, unknown>): Record<string, unknown> | undefined {
  const image = imageSource(part.data, part.url, part.mimeType);
  return image ? { type: "image", image } : undefined;
}

/**
 * User and system content: assistant-ui accepts `status` only on assistant messages and their parts,
 * so these parts never carry one (a malformed part becomes the fallback text without a status).
 */
function userContentParts(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return [textPart(content)];
  if (!Array.isArray(content)) return [textPart(FALLBACK_TEXT)];
  const parts: Record<string, unknown>[] = [];
  for (const rawPart of content) {
    if (!isRecord(rawPart)) {
      parts.push(textPart(FALLBACK_TEXT));
      continue;
    }
    if (rawPart.type === "text" && typeof rawPart.text === "string") {
      parts.push(textPart(rawPart.text));
      continue;
    }
    if (rawPart.type === "image") {
      parts.push(imagePart(rawPart) ?? textPart(FALLBACK_TEXT));
      continue;
    }
    parts.push(textPart(FALLBACK_TEXT));
  }
  return parts.length > 0 ? parts : [textPart("")];
}

function toolPart(
  rawPart: Record<string, unknown>,
  toolStates: readonly RuntimeToolStateReference[],
  status: MessagePartStreamStatus,
): Record<string, unknown> {
  const toolCallId = nonEmptyString(rawPart.id);
  const toolName = nonEmptyString(rawPart.name);
  if (!toolCallId || !toolName || !isRecord(rawPart.arguments)) {
    return textPart(FALLBACK_TEXT, { type: "incomplete", reason: "other" });
  }
  const state = stateFor(toolStates, toolCallId);
  const argsText = nonEmptyString(rawPart.rawBlock) ?? safeJson(rawPart.arguments);
  const result = state?.result !== undefined ? state.result : state?.partialResult;
  const part: Record<string, unknown> = {
    type: "tool-call",
    toolCallId,
    toolName,
    args: rawPart.arguments,
    argsText,
    ...(result === undefined ? {} : { result }),
    ...(state === undefined ? {} : { isError: state.isError ?? state.status === "cancelled" }),
    ...(state?.status === "running" || state?.status === "partial" ? { isPreliminary: true } : {}),
    ...(state?.streamProjection === undefined ? {} : { artifact: state.streamProjection }),
    ...(state === undefined
      ? {}
      : {
          /** R0's state is retained on the part for renderers and diagnostics. */
          status: state.status,
          partialResult: state.partialResult,
          streamProjection: state.streamProjection,
          ompToolState: state,
        }),
    ...(status.type === "running" && state === undefined ? { isPreliminary: true } : {}),
  };
  return part;
}

function assistantParts(
  content: unknown,
  runtime: RuntimeMessage | undefined,
  toolStates: readonly RuntimeToolStateReference[],
): Record<string, unknown>[] {
  const status = streamStatus(runtime);
  if (!Array.isArray(content)) {
    return [textPart(FALLBACK_TEXT, { type: "incomplete", reason: "other" })];
  }
  const parts: Record<string, unknown>[] = [];
  for (const rawPart of content) {
    if (!isRecord(rawPart)) {
      parts.push(textPart(FALLBACK_TEXT, { type: "incomplete", reason: "other" }));
      continue;
    }
    switch (rawPart.type) {
      case "text":
        parts.push(
          typeof rawPart.text === "string"
            ? textPart(rawPart.text, status)
            : textPart(FALLBACK_TEXT, { type: "incomplete", reason: "other" }),
        );
        break;
      case "thinking":
        parts.push(
          typeof rawPart.thinking === "string"
            ? { type: "reasoning", text: rawPart.thinking, status }
            : textPart(FALLBACK_TEXT, { type: "incomplete", reason: "other" }),
        );
        break;
      case "image": {
        const converted = imagePart(rawPart);
        parts.push(converted ?? textPart(FALLBACK_TEXT, { type: "incomplete", reason: "other" }));
        break;
      }
      case "toolCall":
        parts.push(toolPart(rawPart, toolStates, status));
        break;
      default:
        parts.push(textPart(FALLBACK_TEXT, { type: "incomplete", reason: "other" }));
        break;
    }
  }
  return parts.length > 0 ? parts : [textPart("", status)];
}

function toolResultPart(
  message: Record<string, unknown>,
  toolStates: readonly RuntimeToolStateReference[],
): Record<string, unknown> {
  const toolCallId = nonEmptyString(message.toolCallId);
  const toolName = nonEmptyString(message.toolName);
  if (!toolCallId || !toolName)
    return textPart(FALLBACK_TEXT, { type: "incomplete", reason: "other" });
  const state = stateFor(toolStates, toolCallId);
  const result = state?.result !== undefined ? state.result : toolResultFromMessage(message);
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    args: {},
    argsText: "{}",
    ...(result === undefined ? {} : { result }),
    isError: state?.isError ?? message.isError === true,
    ...(state?.status === "running" || state?.status === "partial" ? { isPreliminary: true } : {}),
    ...(state === undefined
      ? {}
      : {
          status: state.status,
          partialResult: state.partialResult,
          streamProjection: state.streamProjection,
          ompToolState: state,
        }),
  };
}

/**
 * A `toolResult` message from history carries the same fields omp's `tool_execution_end` result has
 * (`{ content, details }`), so cards read one shape whether the call ran live or was reopened.
 */
function toolResultFromMessage(message: Record<string, unknown>): unknown {
  if (message.content === undefined) return undefined;
  return message.details === undefined
    ? { content: message.content }
    : { content: message.content, details: message.details };
}
export type ExternalMessage =
  | ThreadMessageLike
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: unknown;
      readonly isError?: boolean;
      readonly artifact?: unknown;
    };

function toolResultExternalMessage(
  message: Record<string, unknown>,
  toolStates: readonly RuntimeToolStateReference[],
): ExternalMessage {
  const toolCallId = nonEmptyString(message.toolCallId);
  const toolName = nonEmptyString(message.toolName);
  if (!toolCallId || !toolName) {
    return {
      role: "assistant",
      content: [textPart(FALLBACK_TEXT, { type: "incomplete", reason: "other" })],
      status: { type: "incomplete", reason: "other" },
    } as unknown as ThreadMessageLike;
  }
  const state = stateFor(toolStates, toolCallId);
  const result = state?.result !== undefined ? state.result : toolResultFromMessage(message);
  return {
    role: "tool",
    toolCallId,
    toolName,
    result,
    isError: state?.isError ?? message.isError === true,
    ...(state?.streamProjection === undefined ? {} : { artifact: state.streamProjection }),
  };
}

function fallbackMessage(id: string): ThreadMessageLike {
  return {
    role: "assistant",
    id,
    content: [textPart(FALLBACK_TEXT, { type: "incomplete", reason: "other" })],
    status: { type: "incomplete", reason: "other" },
    metadata: { custom: { ompFallback: true } },
  } as unknown as ThreadMessageLike;
}

function convertRecord(
  runtime: RuntimeMessage | undefined,
  fallbackMessageValue: unknown,
  index: number,
  toolStates: readonly RuntimeToolStateReference[],
  view?: RuntimeMessageView,
  external = false,
): ExternalMessage {
  const id = messageIdFor(runtime, index);
  const message = runtime?.message ?? fallbackMessageValue;
  if (!isRecord(message) || typeof message.role !== "string") return fallbackMessage(id);
  const createdAt = isFiniteTimestamp(message.timestamp) ? new Date(message.timestamp) : undefined;
  const status = messageStatus(runtime, message);
  const metadata = {
    custom: {
      ompMessageKey: id,
      ompRole: message.role,
      ...(message.role === "assistant"
        ? { ompEntryIds: [...(view?.joinedAssistantEntryIds ?? [id])] }
        : {}),
    },
  };
  switch (message.role) {
    case "user":
      return {
        role: "user",
        id,
        ...(createdAt ? { createdAt } : {}),
        content: userContentParts(message.content),
        metadata,
      } as unknown as ThreadMessageLike;
    case "developer":
      return {
        role: "system",
        id,
        ...(createdAt ? { createdAt } : {}),
        content: userContentParts(message.content),
        metadata,
      } as unknown as ThreadMessageLike;
    case "assistant":
      return {
        role: "assistant",
        id,
        ...(createdAt ? { createdAt } : {}),
        content: assistantParts(message.content, runtime, toolStates),
        status,
        metadata,
      } as unknown as ThreadMessageLike;
    case "toolResult":
      if (external && view?.toolResultMatched !== false)
        return toolResultExternalMessage(message, toolStates);
      return {
        role: "assistant",
        id,
        ...(createdAt ? { createdAt } : {}),
        content: [toolResultPart(message, toolStates)],
        status,
        metadata,
      } as unknown as ThreadMessageLike;
    default:
      return fallbackMessage(id);
  }
}

function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  return isRecord(value) && isRecord(value.message) && typeof value.key === "string";
}

function isRuntimeMessageView(value: unknown): value is RuntimeMessageView {
  return isRecord(value) && isRuntimeMessage(value.record) && Array.isArray(value.toolStates);
}

/**
 * The only omp-to-assistant-ui message conversion. It never throws: malformed wire data becomes a
 * visible assistant fallback part rather than taking down the transcript.
 */
export function convertMessage(
  input: RuntimeMessageView | RuntimeMessage | OmpMessage | unknown,
  index = 0,
): ThreadMessageLike {
  if (isRuntimeMessageView(input)) {
    return convertRecord(
      input.record,
      input.record.message,
      index,
      input.toolStates,
      input,
    ) as ThreadMessageLike;
  }
  if (isRuntimeMessage(input)) {
    return convertRecord(input, input.message, index, []) as ThreadMessageLike;
  }
  return convertRecord(undefined, input, index, []) as ThreadMessageLike;
}

/** The callback used by assistant-ui's external converter, including its supported join strategy. */
export function convertExternalMessage(input: RuntimeMessageView): ExternalMessage {
  return convertRecord(input.record, input.record.message, 0, input.toolStates, input, true);
}

/** A referentially stable converter cache for one external runtime. */
export function createMemoizedMessageConverter(): (
  message: RuntimeMessageView,
  index: number,
) => ThreadMessageLike {
  const cache = new WeakMap<object, ThreadMessageLike>();
  return (message, index) => {
    const previous = cache.get(message);
    if (previous) return previous;
    const converted = convertMessage(message, index);
    cache.set(message, converted);
    return converted;
  };
}

type ProjectedMessageMetadata = {
  readonly joinedAssistantEntryIds: readonly string[];
  readonly toolResultMatched: boolean | undefined;
};

function projectedMessageMetadata(
  snapshot: RuntimeSnapshot,
): Readonly<Record<string, ProjectedMessageMetadata>> {
  const result: Record<string, ProjectedMessageMetadata> = {};
  let segment: RuntimeMessage[] = [];
  const assistantEntryIds: string[] = [];
  const assistantToolCallIds = new Set<string>();
  const flush = (): void => {
    for (const record of segment) {
      const message = record.message;
      result[record.key] = {
        joinedAssistantEntryIds: [...assistantEntryIds],
        toolResultMatched:
          message.role === "toolResult" ? assistantToolCallIds.has(message.toolCallId) : undefined,
      };
    }
    segment = [];
    assistantEntryIds.length = 0;
    assistantToolCallIds.clear();
  };
  for (const key of snapshot.messageOrder) {
    const record = snapshot.messages[key];
    if (!record) continue;
    if (record.message.role !== "assistant" && record.message.role !== "toolResult") {
      flush();
      continue;
    }
    segment.push(record);
    if (record.message.role === "assistant") {
      assistantEntryIds.push(record.entryId ?? record.key);
      for (const toolCallId of toolCallIds(record.message)) assistantToolCallIds.add(toolCallId);
    }
  }
  flush();
  return result;
}

function sameIds(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return (
    left?.length === right.length && left?.every((value, index) => value === right[index]) === true
  );
}

class RuntimeMessageProjector {
  private readonly entries = new WeakMap<
    object,
    {
      readonly references: readonly RuntimeToolStateReference[];
      readonly view: RuntimeMessageView;
    }
  >();
  private previousKeys: readonly string[] = [];
  private previousViews: readonly RuntimeMessageView[] = EMPTY_MESSAGE_VIEWS;

  public project(snapshot: RuntimeSnapshot): readonly RuntimeMessageView[] {
    const views: RuntimeMessageView[] = [];
    const metadata = projectedMessageMetadata(snapshot);
    for (const key of snapshot.messageOrder) {
      const record = snapshot.messages[key];
      if (!record) continue;
      const projected = metadata[key] ?? {
        joinedAssistantEntryIds: [],
        toolResultMatched: undefined,
      };
      const previous = this.entries.get(record);
      if (previous) {
        let unchanged =
          sameIds(previous.view.joinedAssistantEntryIds, projected.joinedAssistantEntryIds) &&
          previous.view.toolResultMatched === projected.toolResultMatched;
        for (const reference of previous.references) {
          if (
            snapshot.tools[reference.toolCallId as keyof typeof snapshot.tools] !== reference.state
          ) {
            unchanged = false;
            break;
          }
        }
        if (unchanged) {
          views.push(previous.view);
          continue;
        }
      }
      const ids = previous
        ? previous.references.map((reference) => reference.toolCallId)
        : toolCallIds(record.message);
      const references = ids.map((toolCallId) => ({
        toolCallId,
        state: snapshot.tools[toolCallId as keyof typeof snapshot.tools],
      }));
      const view: RuntimeMessageView = {
        record,
        toolStates: references,
        joinedAssistantEntryIds: projected.joinedAssistantEntryIds,
        toolResultMatched: projected.toolResultMatched,
      };
      this.entries.set(record, { references, view });
      views.push(view);
    }
    if (
      this.previousKeys.length === snapshot.messageOrder.length &&
      this.previousKeys.every((key, index) => key === snapshot.messageOrder[index]) &&
      this.previousViews.length === views.length &&
      this.previousViews.every((view, index) => view === views[index])
    ) {
      return this.previousViews;
    }
    this.previousKeys = [...snapshot.messageOrder];
    this.previousViews = views;
    return views;
  }
}

function capabilityAvailable(capabilities: CapabilityMap, key: CapabilityKey): boolean {
  return capabilities[key]?.state === "available";
}

function unavailable(capability: CapabilityKey, message: string): AppFailure {
  return new AppFailure({ code: "unavailable", message, retryable: false, capability });
}

function invalidArgs(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

function internalFailure(message: string, cause: unknown): AppFailure {
  return new AppFailure({ code: "internal", message, retryable: true }, { cause });
}

function asFailure(error: unknown, fallback: string): AppFailure {
  return error instanceof AppFailure ? error : internalFailure(fallback, error);
}

function validDelivery(value: unknown): value is PromptDelivery {
  return value === "new" || value === "steer" || value === "followUp";
}

function validMode(value: unknown): value is PromptMode {
  return value === "prompt" || value === "bash" || value === "python";
}

function imagesForAppend(message: AppendMessage): readonly OmpWire.ImageContent[] | undefined {
  if (!Array.isArray(message.content)) return undefined;
  const images: OmpWire.ImageContent[] = [];
  for (const part of message.content) {
    if (!isRecord(part) || part.type !== "image" || typeof part.image !== "string") continue;
    const image = part.image;
    if (image.startsWith("data:")) {
      const comma = image.indexOf(",");
      const header = comma >= 0 ? image.slice(0, comma) : "";
      const data = comma >= 0 ? image.slice(comma + 1) : image;
      const mimeType = header.startsWith("data:")
        ? header.slice(5).split(";", 1)[0] || "application/octet-stream"
        : "application/octet-stream";
      images.push({ type: "image", data, mimeType });
    } else {
      images.push({ type: "image", data: image, mimeType: "image/*", url: image });
    }
  }
  return images.length > 0 ? images : undefined;
}
function attachmentRefsForAppend(message: AppendMessage): readonly AttachmentRef[] | undefined {
  if (!Array.isArray(message.attachments) || message.attachments.length === 0) return undefined;
  const refs: AttachmentRef[] = [];
  for (const attachment of message.attachments) {
    if (
      typeof attachment.id !== "string" ||
      attachment.id.length === 0 ||
      typeof attachment.name !== "string" ||
      attachment.name.length === 0
    ) {
      continue;
    }
    refs.push({
      id: attachment.id,
      name: attachment.name,
      mediaType: attachment.contentType ?? "application/octet-stream",
    });
  }
  return refs.length > 0 ? refs : undefined;
}

function textForAppend(message: AppendMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (part): part is { readonly type: "text"; readonly text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

function promptCommand(intent: PromptIntent): OmpCommand {
  const images = intent.images && intent.images.length > 0 ? [...intent.images] : undefined;
  return {
    type: "prompt",
    message: intent.text,
    ...(images ? { images } : {}),
    ...(intent.delivery === "new" ? {} : { streamingBehavior: intent.delivery }),
  };
}

/** The R0.3 runtime binding used by both React and headless tests. */
export class OmpRuntimeController {
  private readonly store: OmpRuntimeStore;
  private readonly send: RpcSessionSend;
  private readonly projector = new RuntimeMessageProjector();
  private readonly converter = createMemoizedMessageConverter();
  private capabilities: CapabilityMap;
  private onRefetchThread: (() => Promise<void>) | undefined;
  private bashRunning = false;

  private readonly onNew = async (message: AppendMessage): Promise<void> => {
    const current = this.store.getSnapshot();
    const images = imagesForAppend(message);
    const attachmentRefs = attachmentRefsForAppend(message);
    await this.submitPrompt({
      mode: "prompt",
      text: textForAppend(message),
      ...(images ? { images } : {}),
      ...(attachmentRefs ? { attachmentRefs } : {}),
      delivery: current.prompt.streaming ? (message.steer === true ? "steer" : "followUp") : "new",
    });
  };
  private readonly onCancel = (): Promise<void> => this.cancel();
  public constructor(options: OmpRuntimeOptions) {
    this.store = options.store;
    this.send = options.send;
    this.capabilities = options.capabilities ?? EMPTY_CAPABILITIES;
    this.onRefetchThread = options.onRefetchThread;
  }

  public update(options: Pick<OmpRuntimeOptions, "capabilities" | "onRefetchThread">): void {
    this.capabilities = options.capabilities ?? EMPTY_CAPABILITIES;
    this.onRefetchThread = options.onRefetchThread;
  }

  public getSnapshot(): RuntimeSnapshot {
    return this.store.getSnapshot();
  }

  public subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    return this.store.subscribe(listener);
  }

  public messages(snapshot = this.store.getSnapshot()): readonly RuntimeMessageView[] {
    return this.projector.project(snapshot);
  }

  public async submitPrompt(intent: PromptIntent): Promise<void> {
    if (!isRecord(intent) || typeof intent.text !== "string") {
      throw invalidArgs("Prompt text is required");
    }
    if (!validMode(intent.mode) || !validDelivery(intent.delivery)) {
      throw invalidArgs("Prompt mode or delivery is invalid");
    }
    if (intent.images !== undefined && !Array.isArray(intent.images)) {
      throw invalidArgs("Prompt images are invalid");
    }
    if (intent.mode === "python") {
      throw unavailable(
        "upstream.python-mode",
        "Python mode is unavailable until omp exposes a typed RPC capability",
      );
    }
    if (intent.mode === "bash") {
      if (intent.delivery !== "new") {
        throw invalidArgs("Bash commands cannot be steered or queued");
      }
      const capability = "omp.cmd.bash" as CapabilityKey;
      if (!capabilityAvailable(this.capabilities, capability)) {
        throw unavailable(capability, "Bash execution is unavailable for this runtime");
      }
      this.bashRunning = true;
      try {
        await this.send(
          {
            threadId: this.store.getSnapshot().threadId,
            command: { type: "bash", command: intent.text },
          },
          { signal: intent.signal },
        );
      } catch (error) {
        throw asFailure(error, "Bash execution failed");
      } finally {
        this.bashRunning = false;
      }
      return;
    }

    const snapshot = this.store.getSnapshot();
    if (snapshot.prompt.streaming && intent.delivery === "new") {
      // A running turn is never interrupted implicitly (that would be abort_and_prompt); the
      // composer chooses steer or followUp, and the draft is kept.
      throw invalidArgs("A turn is running: steer it or queue the message as a follow-up");
    }
    if (snapshot.prompt.streaming && intent.text.trimStart().startsWith("/")) {
      throw invalidArgs("Slash commands cannot be sent while a prompt is streaming");
    }
    const capability = "omp.cmd.prompt" as CapabilityKey;
    if (!capabilityAvailable(this.capabilities, capability)) {
      throw unavailable(capability, "Prompt submission is unavailable for this runtime");
    }
    try {
      await this.send(
        { threadId: snapshot.threadId, command: promptCommand(intent) },
        { signal: intent.signal },
      );
    } catch (error) {
      throw asFailure(error, "Prompt submission failed before admission");
    }
  }

  public async cancel(options?: { readonly signal?: AbortSignalLike }): Promise<void> {
    const command = this.bashRunning ? "abort_bash" : "abort";
    const capability = `omp.cmd.${command}` as CapabilityKey;
    if (!capabilityAvailable(this.capabilities, capability)) {
      throw unavailable(capability, "Cancelling this runtime is unavailable");
    }
    try {
      await this.send(
        { threadId: this.store.getSnapshot().threadId, command: { type: command } },
        options,
      );
    } catch (error) {
      throw asFailure(error, "Cancelling the omp session failed");
    }
  }

  public createAdapter(
    snapshot = this.store.getSnapshot(),
  ): ExternalStoreAdapter<RuntimeMessageView> {
    const canPrompt = capabilityAvailable(this.capabilities, "omp.cmd.prompt");
    const canBash = capabilityAvailable(this.capabilities, "omp.cmd.bash");
    const canRefetch =
      capabilityAvailable(this.capabilities, "omp.cmd.get_state") &&
      capabilityAvailable(this.capabilities, "omp.cmd.get_entries") &&
      capabilityAvailable(this.capabilities, "omp.cmd.get_tree");
    const adapter: ExternalStoreAdapter<RuntimeMessageView> = {
      messages: this.messages(snapshot),
      convertMessage: this.converter,
      isRunning: snapshot.prompt.streaming,
      isLoading: snapshot.process.status === "starting" || snapshot.process.status === "restarting",
      isSendDisabled: !(canPrompt || canBash),
      onNew: this.onNew,
      unstable_enableToolInvocations: false,
    };
    const cancelCapability = this.bashRunning ? "omp.cmd.abort_bash" : "omp.cmd.abort";
    if (capabilityAvailable(this.capabilities, cancelCapability)) {
      adapter.onCancel = this.onCancel;
    }
    if (this.onRefetchThread && canRefetch) adapter.onRefetchThread = this.onRefetchThread;
    return adapter;
  }
}

export function createOmpRuntime(options: OmpRuntimeOptions): OmpRuntimeController {
  return new OmpRuntimeController(options);
}

export interface OmpRuntime {
  readonly runtime: AssistantRuntime;
  readonly controller: OmpRuntimeController;
}

/** React hook that wires one OmpRuntimeStore to assistant-ui's ExternalStoreRuntime. */
export function useOmpRuntime(options: OmpRuntimeOptions): OmpRuntime {
  const { capabilities, onRefetchThread, send, store } = options;
  const controller = useMemo(
    () =>
      new OmpRuntimeController({
        capabilities,
        onRefetchThread,
        send,
        store,
      }),
    [capabilities, onRefetchThread, send, store],
  );
  controller.update({ capabilities, onRefetchThread });
  const subscribe = useCallback(
    (listener: (snapshot: RuntimeSnapshot) => void): (() => void) => controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = useCallback((): RuntimeSnapshot => controller.getSnapshot(), [controller]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const rawAdapter = useMemo(() => controller.createAdapter(snapshot), [controller, snapshot]);
  const rawMessages = useMemo(() => [...(rawAdapter.messages ?? [])], [rawAdapter.messages]);
  const joinedMessages = useExternalMessageConverter<RuntimeMessageView>({
    callback: convertExternalMessage,
    messages: rawMessages,
    isRunning: rawAdapter.isRunning ?? false,
    joinStrategy: "concat-content",
  });
  const adapter: ExternalStoreAdapter = useMemo(() => {
    const {
      convertMessage: _convertMessage,
      messages: _messages,
      setMessages: _setMessages,
      ...base
    } = rawAdapter;
    return { ...base, messages: joinedMessages };
  }, [joinedMessages, rawAdapter]);
  const runtime = useExternalStoreRuntime(adapter);
  return { runtime, controller };
}
