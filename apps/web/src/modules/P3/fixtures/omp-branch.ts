/**
 * Values P3's branch, edit and regenerate tests send to or read from omp. Recorded wire values come from committed files in
 * `packages/omp-rpc/fixtures/`; synthetic source values and deliberate test seams are marked beside them.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type EntryId,
  EntryId as EntryIdSchema,
  type OmpWire,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";
import { z } from "zod";

type EntryIdLike = string | EntryId;

const RECORDINGS_DIR = resolve(process.cwd(), "../../packages/omp-rpc/fixtures");

/** One row of a recording: a frame omp wrote to stdout, kept as an escaped JSON string in `line`. */
const RecordingRow = z.object({ dir: z.literal("stdout"), line: z.string() });

/** The stdout frame on `line` (1-based, the file's first line is its header) of a recording, parsed as JSON. */
export function recordedFrame(recording: string, line: number): unknown {
  const text = readFileSync(resolve(RECORDINGS_DIR, `${recording}.fixture.jsonl`), "utf8");
  const row = RecordingRow.parse(JSON.parse(text.split("\n")[line - 1] ?? "null"));
  return JSON.parse(row.line);
}

export const SOURCE_CHAT = ThreadIdSchema.parse("fixture-source-chat");
/** The chat omp opens for a branch: the `sessionId` that `get_state` reports after `branch`. */
export const BRANCHED_CHAT = ThreadIdSchema.parse("fixture-branched-chat");

export const ASSISTANT_ANSWER = EntryIdSchema.parse("fixture-assistant-answer");
const WHEN = "2026-10-05T00:00:00.000Z";
const LATER = "2026-10-05T00:00:01.000Z";

/**
 * Fake image bytes recorded in the P3 message fixture. The value is base64 of "image-bytes"; the shape is omp's
 * `ImageContent`, `packages/coding-agent/src/modes/rpc/wire/rpc-wire.generated.ts:27-33` at v18.8.9.
 */
export const PNG_BASE64 = "aW1hZ2UtYnl0ZXM=";

export const PNG_IMAGE: OmpWire.ImageContent = {
  type: "image",
  data: PNG_BASE64,
  mimeType: "image/png",
};

/** The recorded `branch` response from `p3-branch.fixture.jsonl:32`. */
const BranchResponseRecord = z.object({
  type: z.literal("response"),
  command: z.literal("branch"),
  success: z.literal(true),
  data: z.object({ text: z.string(), cancelled: z.boolean() }),
});
function recordedBranchResult(recording: string, line: number): OmpWire.BranchResult {
  return BranchResponseRecord.parse(recordedFrame(recording, line)).data;
}

export const BRANCH_ACCEPTED = recordedBranchResult("p3-branch", 32);
/** The recorded hook-cancelled `branch` response from `p3-branch-cancelled.fixture.jsonl:30`. */
export const BRANCH_CANCELLED = recordedBranchResult("p3-branch-cancelled", 30);

/**
 * The `get_state` answer the app reads after a branch. Only `sessionId` is read: `SessionState.sessionId` at
 * `packages/coding-agent/src/modes/rpc/wire/rpc-wire.generated.ts:480-481` (v18.8.9). Its key is in the recorded
 * `get_state` answer at `packages/omp-rpc/fixtures/out-of-order.fixture.jsonl:10` (`data.sessionId`). The value is
 * the fixture's own id.
 */
export const STATE_AFTER_BRANCH: { readonly sessionId: string } = { sessionId: BRANCHED_CHAT };

/**
 * The recorded get_branch_messages response is at p3-branch-messages.fixture.jsonl:95. It contains the two text-bearing
 * rows still on the branch after the rewind; the image-only user message is omitted. The separate image-only recording
 * (p3-branch-image.fixture.jsonl:30) records an empty list. This fixture does not cover listing an abandoned row.
 */
const BranchMessagesResponseRecord = z.object({
  type: z.literal("response"),
  command: z.literal("get_branch_messages"),
  success: z.literal(true),
  data: z.object({ messages: z.array(z.object({ entryId: z.string(), text: z.string() })) }),
});
export const BRANCH_MESSAGES = BranchMessagesResponseRecord.parse(
  recordedFrame("p3-branch-messages", 95),
).data;
function recordedBranchMessageId(text: string): EntryId {
  const message = BRANCH_MESSAGES.messages.find((row) => row.text === text);
  if (!message) throw new Error(`p3-branch-messages recording has no ${JSON.stringify(text)} row`);
  return EntryIdSchema.parse(message.entryId);
}
/** Recorded entry IDs for the text-only and text-plus-image rows used by P3's store fixtures. */
export const USER_TEXT_ONLY = recordedBranchMessageId("Earlier question");
export const USER_WITH_IMAGE = recordedBranchMessageId("Explain");

/**
 * A `prompt_result` frame: `RpcPromptResultFrame` (`rpc-types.ts:232-245` at v18.8.9). Its `status` is `RpcPromptStatus`
 * (`rpc-types.ts:212`: "completed", "aborted" or "error"). The schema is the boundary: a recorded frame that does not
 * match it fails the test.
 */
const PromptResultRecord = z.object({
  type: z.literal("prompt_result"),
  id: z.string(),
  agentInvoked: z.boolean(),
  status: z.enum(["completed", "aborted", "error"]),
  sessionSettled: z.boolean(),
  error: z
    .object({
      message: z.string(),
      provider: z.string(),
      model: z.string(),
      retryable: z.boolean(),
      httpStatus: z.number(),
    })
    .optional(),
});

/** A `prompt_result` frame; `error` is set only with `status: "error"` (`rpc-types.ts:218-226`). */
export type PromptResultFrame = z.infer<typeof PromptResultRecord> & {
  readonly error?: { readonly message: string; readonly retryable: boolean };
};

/** A recorded `prompt_result`, parsed from its line. */
export function recordedPromptResult(recording: string, line: number): PromptResultFrame {
  return PromptResultRecord.parse(recordedFrame(recording, line));
}

/** The completed turn, recorded: `prompt-stream.fixture.jsonl:38` (`status: "completed"`, `sessionSettled: true`). */
export function promptCompleted(): PromptResultFrame {
  return recordedPromptResult("prompt-stream", 38);
}

/** The aborted turn, recorded: `abort.fixture.jsonl:23` (`status: "aborted"`), followed by `SESSION_SETTLED`. */
export function promptAborted(): PromptResultFrame {
  return recordedPromptResult("abort", 23);
}

/**
 * A completed turn that leaves background work open (`sessionSettled: false`). No recording has one, so the value is
 * the documented shape: `rpc-types.ts:239-244` says a `session_settled` frame follows when the field is false, and
 * `rpc-prompt-results.ts:156-163` writes it. The id is the fixture's own.
 */
export function promptPending(id: string): PromptResultFrame {
  return {
    type: "prompt_result",
    id,
    agentInvoked: true,
    status: "completed",
    sessionSettled: false,
  };
}

/** The recorded provider failure from `p3-provider-error.fixture.jsonl:41`. */
export function promptErrorRecorded(): PromptResultFrame {
  return recordedPromptResult("p3-provider-error", 41);
}

/** The frame once the session is done with every tracked job: `abort.fixture.jsonl:24`. */
export const SESSION_SETTLED = z
  .object({ type: z.literal("session_settled") })
  .parse(recordedFrame("abort", 24));

/** A recorded message envelope: role, attribution and timestamp of a `message_end` or `message_start` frame. */
const RecordedMessageFrame = z.object({ message: z.looseObject({ role: z.string() }) });

/** The user envelope, recorded: `prompt-stream.fixture.jsonl:13` (`message_end`, role user, attribution, timestamp). */
function recordedUserEnvelope(): Record<string, unknown> {
  const { message } = RecordedMessageFrame.parse(recordedFrame("prompt-stream", 13));
  if (message.role !== "user")
    throw new Error("prompt-stream.fixture.jsonl line 13 is not a user message");
  return message;
}

/**
 * The assistant answer as omp stores it: the message `prompt-stream.fixture.jsonl:14` records (a `message_start`, with
 * the thinking block the fake model sent). It is typed as omp's `AssistantMessage` (`rpc-wire.generated.ts:114-133` at
 * v18.8.9), so a missing field is a type error; `usage` carries the `totalTokens` and `cost` that `Usage` requires
 * (`:76-82`; `UsageCost` `:68-74`). `recorded-fixtures.test.ts` checks these values against line 14.
 */
const STORED_ANSWER: OmpWire.AssistantMessage = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "I should run bash.", thinkingSignature: "reasoning_content" },
  ],
  api: "openai-completions",
  provider: "fake",
  model: "fake-model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1791209789564,
  responseId: "chatcmpl-fake",
};

/** A stored user message with text and an image: a session entry (`session-entries.ts:77-80`) around the recorded envelope. */
export function storedUserWithImage(id: EntryIdLike, parentId: EntryIdLike | null) {
  return {
    type: "message",
    id: String(id),
    parentId: parentId === null ? null : String(parentId),
    timestamp: WHEN,
    message: {
      ...recordedUserEnvelope(),
      content: [{ type: "text", text: "Explain" }, PNG_IMAGE],
    },
  };
}

/** A stored user message with text only, as the recorded envelope holds it. */
export function storedUserText(id: EntryIdLike, parentId: EntryIdLike | null, text: string) {
  return {
    type: "message",
    id: String(id),
    parentId: parentId === null ? null : String(parentId),
    timestamp: WHEN,
    message: { ...recordedUserEnvelope(), content: [{ type: "text", text }] },
  };
}

/** A stored assistant answer: a session entry (`session-entries.ts:77-80`) around `STORED_ANSWER`. */
export function storedAssistant(id: EntryIdLike, parentId: EntryIdLike) {
  return {
    type: "message",
    id: String(id),
    parentId: String(parentId),
    timestamp: LATER,
    message: structuredClone(STORED_ANSWER),
  };
}

/** The recorded `branch_summary` session entry and its ids are read from `p3-branch-summary.fixture.jsonl:34`. */
const BranchSummaryEntryRecord = z.object({
  type: z.literal("branch_summary"),
  id: z.string(),
  parentId: z.string(),
  timestamp: z.string(),
  fromId: z.string(),
  summary: z.string(),
});
const EntriesResponseRecord = z.object({ data: z.object({ entries: z.array(z.unknown()) }) });
const RECORDED_BRANCH_SUMMARY = BranchSummaryEntryRecord.parse(
  EntriesResponseRecord.parse(recordedFrame("p3-branch-summary", 34)).data.entries.find(
    (entry): entry is { type: string } =>
      typeof entry === "object" &&
      entry !== null &&
      "type" in entry &&
      entry.type === "branch_summary",
  ),
);
export const BRANCH_SUMMARY_ENTRY = EntryIdSchema.parse(RECORDED_BRANCH_SUMMARY.id);
export const BRANCH_SUMMARY_FROM_ID = EntryIdSchema.parse(RECORDED_BRANCH_SUMMARY.fromId);
export function storedBranchSummary(
  id: EntryIdLike,
  parentId: EntryIdLike,
  fromId: EntryIdLike,
  summary: string,
) {
  return {
    type: "branch_summary",
    id: String(id),
    parentId: String(parentId),
    timestamp: LATER,
    fromId: String(fromId),
    summary,
  };
}

/** The recorded branch summary text, preserved through the P3 summary renderer. */
export const BRANCH_SUMMARY_TEXT = RECORDED_BRANCH_SUMMARY.summary;

/**
 * The `branchSummary` wire message: `{ role, summary, fromId, timestamp }`, `wire/rpc-wire.generated.ts:193-198` at
 * v18.8.9. `timestamp` is epoch milliseconds, which the store reads from the entry's ISO timestamp.
 */
export function branchSummaryMessage(
  fromId: EntryIdLike,
  summary: string,
): OmpWire.BranchSummaryMessage {
  return { role: "branchSummary", summary, fromId: String(fromId), timestamp: Date.parse(LATER) };
}
