/**
 * Values P3's branch, edit and regenerate tests send to or read from omp. Recorded values come from the session
 * recordings (P3's `recordings/`, and R0's `prompt-stream` and `abort`); synthetic source values and deliberate test seams
 * are marked beside them.
 */
import {
  type ChatSessionEvent,
  type EntryId,
  EntryId as EntryIdSchema,
  type OmpWire,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";
import { z } from "zod";
import {
  recordedChatEvents,
  recordedResults,
  type SessionRecording,
} from "@/modules/R0/fixtures/recorded-session";
import { ABORT, PROMPT_STREAM } from "@/modules/R0/fixtures/recordings";
import {
  P3_BRANCH,
  P3_BRANCH_CANCELLED,
  P3_BRANCH_MESSAGES,
  P3_BRANCH_SUMMARY,
  P3_PROVIDER_ERROR,
} from "./recordings";

type EntryIdLike = string | EntryId;

/** The one result the recording gives `method`. */
function onlyResult(recording: SessionRecording, method: string): unknown {
  const [result, ...more] = recordedResults(recording, method);
  if (result === undefined || more.length > 0)
    throw new Error(`${recording.header.scenario} does not answer ${method} exactly once`);
  return result;
}

/** The one chat event of `type` the recording has. */
function onlyChatEvent(recording: SessionRecording, type: string): ChatSessionEvent {
  const [event, ...more] = recordedChatEvents(recording, type);
  if (event === undefined || more.length > 0)
    throw new Error(`${recording.header.scenario} does not have exactly one ${type}`);
  return event;
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

/** omp's answer to `branch`: the branched-from prompt's text, and whether an extension's hook cancelled the branch. */
const BranchResultRecord = z.strictObject({ text: z.string(), cancelled: z.boolean() });

/** The recorded accepted `branch` (`p3-branch`). */
export const BRANCH_ACCEPTED: OmpWire.BranchResult = BranchResultRecord.parse(
  onlyResult(P3_BRANCH, "branch"),
);
/** The recorded hook-cancelled `branch` (`p3-branch-cancelled`). */
export const BRANCH_CANCELLED: OmpWire.BranchResult = BranchResultRecord.parse(
  onlyResult(P3_BRANCH_CANCELLED, "branch"),
);

/**
 * The `get_state` answer the app reads after a branch. Only `sessionId` is read: `ChatHostState.sessionId`, the host's
 * `get_state` answer (`packages/contracts/src/chat-host/protocol.ts`). The value is the fixture's own id.
 */
export const STATE_AFTER_BRANCH: { readonly sessionId: string } = { sessionId: BRANCHED_CHAT };

/**
 * The recorded `get_branch_messages` answer (`p3-branch-messages`): the two text-bearing rows still on the branch after
 * the rewind; the image-only user message is omitted. The image-only recording (`p3-branch-image`) answers an empty
 * list. This fixture does not cover listing an abandoned row.
 */
const BranchMessagesRecord = z.strictObject({
  messages: z.array(z.strictObject({ entryId: z.string(), text: z.string() })),
});
export const BRANCH_MESSAGES = BranchMessagesRecord.parse(
  onlyResult(P3_BRANCH_MESSAGES, "get_branch_messages"),
);
function recordedBranchMessageId(text: string): EntryId {
  const message = BRANCH_MESSAGES.messages.find((row) => row.text === text);
  if (!message) throw new Error(`p3-branch-messages recording has no ${JSON.stringify(text)} row`);
  return EntryIdSchema.parse(message.entryId);
}
/** Recorded entry IDs for the text-only and text-plus-image rows used by P3's store fixtures. */
export const USER_TEXT_ONLY = recordedBranchMessageId("Earlier question");
export const USER_WITH_IMAGE = recordedBranchMessageId("Explain");

/**
 * A `prompt_result` as the session port carries it: the host's `PromptResultEvent`
 * (`packages/contracts/src/chat-host/protocol.ts`). The schema is the boundary: a recorded result that does not match it
 * fails the test.
 */
const PromptResultRecord = z.strictObject({
  kind: z.literal("event"),
  event: z.strictObject({
    type: z.literal("prompt_result"),
    requestId: z.string(),
    agentInvoked: z.boolean(),
    status: z.enum(["completed", "aborted", "error"]),
    sessionSettled: z.boolean(),
    error: z
      .strictObject({
        message: z.string(),
        provider: z.string(),
        model: z.string(),
        retryable: z.boolean(),
        httpStatus: z.number(),
      })
      .optional(),
  }),
});

/** The recording's one prompt result, checked against the host's shape. */
function recordedPromptResult(recording: SessionRecording): ChatSessionEvent {
  const event = onlyChatEvent(recording, "prompt_result");
  PromptResultRecord.parse(event);
  return event;
}

/** The completed turn, recorded (`prompt-stream`: `status: "completed"`, `sessionSettled: true`). */
export function promptCompleted(): ChatSessionEvent {
  return recordedPromptResult(PROMPT_STREAM);
}

/** The aborted turn, recorded (`abort`: `status: "aborted"`), followed by `SESSION_SETTLED`. */
export function promptAborted(): ChatSessionEvent {
  return recordedPromptResult(ABORT);
}

/**
 * A completed turn that leaves background work open (`sessionSettled: false`). No recording has one, so the value is
 * the host's documented shape: `PromptResultEvent.sessionSettled` says that a `session_settled` event follows when it is
 * false (`packages/contracts/src/chat-host/protocol.ts`). The request id is the fixture's own.
 */
export function promptPending(requestId: string): ChatSessionEvent {
  return {
    kind: "event",
    event: {
      type: "prompt_result",
      requestId,
      agentInvoked: true,
      status: "completed",
      sessionSettled: false,
    },
  };
}

/** The recorded provider failure (`p3-provider-error`). */
export function promptErrorRecorded(): ChatSessionEvent {
  return recordedPromptResult(P3_PROVIDER_ERROR);
}

/** The payload once the session is done with every tracked job, recorded after the aborted turn (`abort`). */
export const SESSION_SETTLED: ChatSessionEvent = onlyChatEvent(ABORT, "session_settled");

/** A recorded message envelope: role, attribution and timestamp of a `message_end` or `message_start` event. */
const RecordedMessageEvent = z.object({
  event: z.object({ message: z.looseObject({ role: z.string() }) }),
});

/** The user envelope, recorded: the user's `message_end` in `prompt-stream` (role user, attribution, timestamp). */
function recordedUserEnvelope(): Record<string, unknown> {
  const user = recordedChatEvents(PROMPT_STREAM, "message_end")
    .map((event) => RecordedMessageEvent.parse(event).event.message)
    .find((message) => message.role === "user");
  if (user === undefined) throw new Error("prompt-stream has no user message_end");
  return user;
}

/**
 * The assistant answer as omp stores it: the message of the assistant's `message_start` in `prompt-stream` (with the
 * thinking block the fake model sent). It is typed as omp's `AssistantMessage` (`rpc-wire.generated.ts:114-133` at
 * v18.8.9), so a missing field is a type error; `usage` carries the `totalTokens` and `cost` that `Usage` requires
 * (`:76-82`; `UsageCost` `:68-74`). `recorded-fixtures.test.ts` checks these values against the recording.
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

/**
 * The recorded `branch_summary` session entry and its ids: in the entries `p3-branch-summary` reads after its branch (its
 * last `get_entries` answer).
 */
const BranchSummaryEntryRecord = z.object({
  type: z.literal("branch_summary"),
  id: z.string(),
  parentId: z.string(),
  timestamp: z.string(),
  fromId: z.string(),
  summary: z.string(),
});
const EntriesRecord = z.object({ entries: z.array(z.unknown()) });
const RECORDED_BRANCH_SUMMARY = BranchSummaryEntryRecord.parse(
  EntriesRecord.parse(recordedResults(P3_BRANCH_SUMMARY, "get_entries").at(-1)).entries.find(
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
