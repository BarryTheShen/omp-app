import type { AttachmentRef, CapabilityMap } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { PromptIntent } from "../../R0/runtime/runtime";
import {
  type DraftRestoreRequest,
  defaultSubmitPolicy,
  restoreDraft,
  type SubmitPolicy,
  type SubmitPolicyInput,
  type SubmitPolicyResult,
} from "../../U2/contract";
import type { QueueAdapterController } from "../contract";

const QUEUE_PREFIXES = ["->", "=>"] as const;
const QUEUE_LIST_MARKER_RE = /^(\s*)(\d+|[A-Za-z]+)([.)])(?=[\t ]|$)/;
const CANONICAL_ROMAN_RE =
  /^(?=[MDCLXVI])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i;

interface EnumeratedItem {
  readonly line: number;
  readonly indent: string;
  readonly marker: string;
  readonly punctuation: string;
  readonly content: string;
}

interface EnumeratedList {
  readonly source: string;
  readonly lines: readonly string[];
  readonly items: readonly EnumeratedItem[];
}

export interface QueueIntentOptions {
  readonly images?: readonly NonNullable<PromptIntent["images"]>[number][];
  readonly attachmentRefs?: readonly AttachmentRef[];
}

export interface QueueDraftConflict {
  readonly queued: DraftRestoreRequest;
  readonly existing: DraftRestoreRequest;
}

export type QueueDraftConflictChoice = "queued" | "existing" | "cancel";

export interface DequeueToEditOptions {
  readonly getDraft: () => DraftRestoreRequest;
  readonly restoreDraft: (request: DraftRestoreRequest) => void;
  readonly chooseConflict?: (
    conflict: QueueDraftConflict,
  ) => QueueDraftConflictChoice | Promise<QueueDraftConflictChoice>;
}

export interface DequeueToEditResult {
  readonly removed: boolean;
  readonly restored: boolean;
  readonly choice: QueueDraftConflictChoice;
}

function invalidArgs(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

function asText(value: string): string {
  return value.trim();
}

function parseEnumeratedItem(line: string, lineIndex: number): EnumeratedItem | undefined {
  const match = QUEUE_LIST_MARKER_RE.exec(line);
  if (!match) return undefined;
  const [, indent, marker, punctuation] = match;
  if (indent === undefined || marker === undefined || punctuation === undefined) return undefined;
  return {
    line: lineIndex,
    indent,
    marker,
    punctuation,
    content: line.slice(match[0].length).trimStart(),
  };
}

function decodeDecimal(marker: string): number | undefined {
  if (!/^\d+$/.test(marker)) return undefined;
  const value = Number(marker);
  return Number.isSafeInteger(value) ? value : undefined;
}

function decodeRoman(marker: string): number | undefined {
  if (!CANONICAL_ROMAN_RE.test(marker)) return undefined;
  const values: Readonly<Record<string, number>> = {
    I: 1,
    V: 5,
    X: 10,
    L: 50,
    C: 100,
    D: 500,
    M: 1000,
  };
  const upper = marker.toUpperCase();
  let value = 0;
  for (let index = 0; index < upper.length; index += 1) {
    const current = values[upper[index] ?? ""];
    if (current === undefined) return undefined;
    const next = values[upper[index + 1] ?? ""] ?? 0;
    value += current < next ? -current : current;
  }
  return value;
}

function decodeAlpha(marker: string): number | undefined {
  if (!/^[A-Za-z]+$/.test(marker)) return undefined;
  let value = 0;
  for (const char of marker.toUpperCase()) {
    value = value * 26 + char.charCodeAt(0) - 64;
    if (!Number.isSafeInteger(value)) return undefined;
  }
  return value;
}

function sequential(
  markers: readonly string[],
  decode: (marker: string) => number | undefined,
): boolean {
  let previous = decode(markers[0] ?? "");
  if (previous === undefined) return false;
  for (let index = 1; index < markers.length; index += 1) {
    const current = decode(markers[index] ?? "");
    if (current === undefined || current !== previous + 1) return false;
    previous = current;
  }
  return true;
}

function isEnumeratedSequence(items: readonly EnumeratedItem[]): boolean {
  const markers = items.map((item) => item.marker);
  if (markers.every((marker) => /^\d+$/.test(marker))) return sequential(markers, decodeDecimal);
  if (
    !markers.every((marker) => marker === marker.toUpperCase()) &&
    !markers.every((marker) => marker === marker.toLowerCase())
  ) {
    return false;
  }
  return sequential(markers, decodeRoman) || sequential(markers, decodeAlpha);
}

function parseEnumeratedList(text: string): EnumeratedList | undefined {
  const source = text.trim();
  if (!source) return undefined;
  const lines = source.split(/\r?\n/);
  const first = parseEnumeratedItem(lines[0] ?? "", 0);
  if (!first) return undefined;
  const items: EnumeratedItem[] = [first];
  for (let line = 1; line < lines.length; line += 1) {
    const item = parseEnumeratedItem(lines[line] ?? "", line);
    if (item?.indent === first.indent) items.push(item);
  }
  if (
    items.length < 2 ||
    items.some((item) => item.punctuation !== first.punctuation) ||
    !isEnumeratedSequence(items)
  ) {
    return undefined;
  }
  return { source, lines, items };
}

/** Mirrors omp v18.6.1 `packages/tui/src/prompt/queue-input.ts`. */
export function splitQueuedMessages(text: string): readonly string[] {
  const list = parseEnumeratedList(text);
  if (!list) {
    const source = asText(text);
    return source ? [source] : [];
  }
  const messages = list.items.map((item, index) => {
    const nextLine = list.items[index + 1]?.line ?? list.lines.length;
    return [item.content, ...list.lines.slice(item.line + 1, nextLine)].join("\n").trim();
  });
  while (messages.at(-1) === "") messages.pop();
  return messages.length > 0 && messages.every(Boolean) ? messages : [list.source];
}

function queueBody(text: string): string | undefined {
  const trimmed = text.trim();
  const match = /^\/queue(?:\s+|:)([\s\S]*)$/i.exec(trimmed);
  if (match) return match[1] ?? "";
  if (trimmed.toLowerCase() === "/queue") return "";
  const shorthand = QUEUE_PREFIXES.find((prefix) => trimmed.startsWith(prefix));
  return shorthand === undefined ? undefined : trimmed.slice(shorthand.length).trim();
}

export function isQueueSubmission(text: string): boolean {
  return queueBody(text) !== undefined;
}

export function queueSubmissionIntents(
  text: string,
  options: QueueIntentOptions = {},
): readonly PromptIntent[] {
  const body = queueBody(text);
  if (body === undefined) throw invalidArgs("Queue shorthand must start with /queue, ->, or =>");
  const messages = splitQueuedMessages(body);
  if (messages.length === 0) throw invalidArgs("Queue message cannot be empty");
  return messages.map((message, index) => ({
    mode: "prompt",
    text: message,
    delivery: "followUp",
    ...(index === 0 && options.images && options.images.length > 0
      ? { images: [...options.images] }
      : {}),
    ...(index === 0 && options.attachmentRefs && options.attachmentRefs.length > 0
      ? { attachmentRefs: [...options.attachmentRefs] }
      : {}),
  }));
}

export interface QueueSubmitPolicyOptions {
  readonly capabilities?: CapabilityMap;
}

/** P6 policy: Enter steers while streaming; Ctrl+Enter/Cmd+Enter queues follow-up. */
export function queueSubmitPolicy(
  input: SubmitPolicyInput,
  _options: QueueSubmitPolicyOptions = {},
): SubmitPolicyResult {
  if (isQueueSubmission(input.draft.text)) {
    return {
      split: queueSubmissionIntents(input.draft.text, {
        images: input.draft.images,
        attachmentRefs: input.draft.attachmentRefs,
      }),
    };
  }
  if (input.keyChord === "ctrlEnter" || input.keyChord === "metaEnter") {
    return { delivery: "followUp" };
  }
  return defaultSubmitPolicy(input);
}

export function resolveQueueSubmitPolicy(input: SubmitPolicyInput): SubmitPolicyResult {
  const policy: SubmitPolicy = queueSubmitPolicy;
  const result = policy(input);
  if (input.isStreaming && "delivery" in result && result.delivery === "new") {
    throw invalidArgs("A turn is running: choose steer or follow-up");
  }
  if (
    input.isStreaming &&
    "split" in result &&
    result.split.some((intent) => intent.delivery === "new")
  ) {
    throw invalidArgs("A turn is running: split submissions must use steer or follow-up");
  }
  return result;
}

export async function dequeueToEdit(
  controller: QueueAdapterController,
  queueItemId: string,
  options: DequeueToEditOptions,
): Promise<DequeueToEditResult> {
  const item = [...controller.getSnapshot().items, ...controller.getSnapshot().steerItems].find(
    (candidate) => candidate.id === queueItemId,
  );
  if (!item)
    throw new AppFailure({
      code: "not_found",
      message: "The queued message is no longer present",
      retryable: false,
    });
  const queued = restoreDraft(item.prompt, []);
  const existing = options.getDraft();
  const hasExisting = existing.text.length > 0 || existing.attachmentRefs.length > 0;
  let choice: QueueDraftConflictChoice = "queued";
  if (hasExisting) {
    if (!options.chooseConflict) {
      throw invalidArgs("A draft is already being edited; choose which text to keep");
    }
    choice = await options.chooseConflict({ queued, existing });
    if (choice === "cancel") return { removed: false, restored: false, choice };
  }
  controller.adapter.remove(queueItemId);
  if (choice === "queued") options.restoreDraft(queued);
  else options.restoreDraft(existing);
  return { removed: true, restored: true, choice };
}

export { restoreDraft };
