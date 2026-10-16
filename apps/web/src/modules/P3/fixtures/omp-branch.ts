/**
 * Values P3's branch, edit and regenerate tests send to or read from omp. Each value is one of:
 *   - a frame recorded on main: `packages/omp-rpc/fixtures/<name>.fixture.jsonl`, written by omp 18.6.1 in scripted
 *     fake-model runs (`"version":"18.6.1"` in each file). `recordedFrame` reads one row, whose `line` holds the frame
 *     as an escaped JSON string;
 *   - a shape taken from omp v18.8.9 source, cited beside it as `packages/...:line` (`git show v18.8.9:<path>`), with no
 *     recording of its own; or
 *   - a stand-in, marked "stand-in": no recording or source line establishes its value.
 * Session ids, entry ids and text are scrubbed fixture values; the shapes are omp's.
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

/** A user message with text and an image; its assistant answer is its child. */
export const USER_WITH_IMAGE = EntryIdSchema.parse("fixture-user-text-image");
export const ASSISTANT_ANSWER = EntryIdSchema.parse("fixture-assistant-answer");
/** A user message with text only, on the current branch. */
export const USER_TEXT_ONLY = EntryIdSchema.parse("fixture-user-text");
/** A user message on a branch the current chat no longer shows. */
export const ABANDONED_USER = EntryIdSchema.parse("fixture-user-abandoned");
export const BRANCH_SUMMARY_ENTRY = EntryIdSchema.parse("fixture-branch-summary");

const WHEN = "2026-10-05T00:00:00.000Z";
const LATER = "2026-10-05T00:00:01.000Z";

/**
 * Stand-in image bytes: base64 of "image-bytes". No recording carries an image. The shape is omp's `ImageContent`,
 * `packages/coding-agent/src/modes/rpc/wire/rpc-wire.generated.ts:27-33` at v18.8.9.
 */
export const PNG_BASE64 = "aW1hZ2UtYnl0ZXM=";

export const PNG_IMAGE: OmpWire.ImageContent = {
  type: "image",
  data: PNG_BASE64,
  mimeType: "image/png",
};

/**
 * The `branch` response data, `{ text, cancelled }` (`packages/coding-agent/src/modes/rpc/rpc-types.ts:540` at v18.8.9).
 * `rpc-mode.ts:882-885` builds it from `session.branch`, whose `text` is the selected user message's text
 * (`agent-session.ts:11706`). It carries no images: `agent-session.ts:11707` reads them for the caller of `branch()`,
 * and `rpc-mode.ts:885` does not send them.
 */
export const BRANCH_ACCEPTED: OmpWire.BranchResult = { text: "Explain", cancelled: false };

/**
 * A branch a hook cancelled: the same shape with `cancelled: true`, which `agent-session.ts:11709`
 * (`cancelled: !completed`) produces and `rpc-mode.ts:885` returns.
 */
export const BRANCH_CANCELLED: OmpWire.BranchResult = { text: "Explain", cancelled: true };

/**
 * The `get_state` answer the app reads after a branch. Only `sessionId` is read: `SessionState.sessionId` at
 * `packages/coding-agent/src/modes/rpc/wire/rpc-wire.generated.ts:480-481` (v18.8.9). Its key is in the recorded
 * `get_state` answer at `packages/omp-rpc/fixtures/out-of-order.fixture.jsonl:10` (`data.sessionId`). The value is
 * the fixture's own id.
 */
export const STATE_AFTER_BRANCH: { readonly sessionId: string } = { sessionId: BRANCHED_CHAT };

/**
 * The `get_branch_messages` result: `{ messages: [{ entryId, text }] }`, `rpc-types.ts:547` (v18.8.9). omp lists every
 * user message with non-empty text across the whole session, text only (`agent-session.ts:12386-12401`), from
 * `sessionManager.getEntries()` (`session-manager.ts:3722-3724`), so an image-only message is absent and a message on an
 * abandoned branch is present. `rpc-mode.ts:2398-2400` sends the list. The rows are the fixture's own values.
 */
export const BRANCH_MESSAGES: OmpWire.GetBranchMessagesResult = {
  messages: [
    { entryId: String(USER_TEXT_ONLY), text: "Earlier question" },
    { entryId: String(USER_WITH_IMAGE), text: "Explain" },
    { entryId: String(ABANDONED_USER), text: "Question on an abandoned branch" },
  ],
};

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

/**
 * A provider failure. Stand-in: no recording has a `prompt_result` with `status: "error"`. The status and the `error`
 * object are `rpc-types.ts:212` and `:218-226`; the message and the `retryable` flag are the fixture's own values, not
 * omp's text. Issue 1692 records a real error frame.
 */
export function promptErrorStandIn(id: string): PromptResultFrame {
  return {
    type: "prompt_result",
    id,
    agentInvoked: true,
    status: "error",
    sessionSettled: true,
    error: { message: "stand-in provider message", retryable: true },
  };
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

/**
 * omp's `branch_summary` session entry: `fromId` and `summary` on the base (`session-entries.ts:70-75`), at
 * `session-entries.ts:148-156` (v18.8.9). The app turns a non-empty summary into a message (`R0/store/store.ts:735-747`);
 * omp's own context skips an empty one (`session-context.ts:415-416`).
 */
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

/** The summary text a branch summary carries (the fixture's own Markdown, no file list). */
export const BRANCH_SUMMARY_TEXT =
  "## Goal\n\nKeep the original conversation.\n\n- The new chat starts from an earlier message.";

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
