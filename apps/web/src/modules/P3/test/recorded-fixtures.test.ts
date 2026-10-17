import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkScrubbed, parseFixture } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  ASSISTANT_ANSWER,
  BRANCH_ACCEPTED,
  BRANCH_CANCELLED,
  BRANCH_MESSAGES,
  BRANCH_SUMMARY_ENTRY,
  BRANCH_SUMMARY_FROM_ID,
  BRANCH_SUMMARY_TEXT,
  promptAborted,
  promptCompleted,
  promptErrorRecorded,
  recordedFrame,
  SESSION_SETTLED,
  storedAssistant,
  storedUserText,
  USER_TEXT_ONLY,
  USER_WITH_IMAGE,
} from "../fixtures/omp-branch";

const RECORDINGS_DIR = resolve(process.cwd(), "../../packages/omp-rpc/fixtures");
const NEW_RECORDINGS = [
  "p3-branch",
  "p3-branch-cancelled",
  "p3-branch-image",
  "p3-branch-messages",
  "p3-branch-summary",
  "p3-provider-error",
] as const;

describe("new P3 recordings", () => {
  test.each(NEW_RECORDINGS)("%s parses and every line is scrubbed", (recording) => {
    const text = readFileSync(resolve(RECORDINGS_DIR, `${recording}.fixture.jsonl`), "utf8");
    expect(parseFixture(text).ok).toBe(true);
    expect(checkScrubbed(text)).toEqual([]);
  });

  test("accepted branch keeps the recorded request id, result text and uncancelled status", () => {
    const expected = {
      id: "rpc-4",
      type: "response",
      command: "branch",
      success: true,
      data: { text: "count_reply branch", cancelled: false },
    };
    expect(recordedFrame("p3-branch", 32)).toEqual(expected);
    expect(BRANCH_ACCEPTED).toEqual(expected.data);
  });

  test("the hook-cancelled branch keeps the recorded request id, text and cancelled status", () => {
    const expected = {
      id: "rpc-4",
      type: "response",
      command: "branch",
      success: true,
      data: { text: "count_reply cancelled", cancelled: true },
    };
    expect(recordedFrame("p3-branch-cancelled", 30)).toEqual(expected);
    expect(BRANCH_CANCELLED).toEqual(expected.data);
  });

  test("the image-only user frame is present, while get_branch_messages omits it", () => {
    expect(recordedFrame("p3-branch-image", 14)).toMatchObject({
      type: "message_start",
      message: {
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "image", data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" },
        ],
      },
    });
    expect(recordedFrame("p3-branch-image", 30)).toEqual({
      id: "rpc-3",
      type: "response",
      command: "get_branch_messages",
      success: true,
      data: { messages: [] },
    });
  });

  test("get_branch_messages uses its recorded rows and ids; it does not claim abandoned-row coverage", () => {
    const messages = [
      { entryId: "761415f7", text: "Earlier question" },
      { entryId: "459d04e2", text: "Explain" },
    ];
    expect(recordedFrame("p3-branch-messages", 95)).toEqual({
      id: "rpc-8",
      type: "response",
      command: "get_branch_messages",
      success: true,
      data: { messages },
    });
    expect(BRANCH_MESSAGES.messages).toEqual(messages);
  });

  test("branch summary retains the recorded entry ids and text", () => {
    const summary = {
      type: "branch_summary",
      id: "0796c2ca",
      parentId: "c1139e17",
      timestamp: "2026-10-17T02:57:22.199Z",
      fromId: "c1139e17",
      summary:
        "## Goal\n\nKeep the original conversation.\n\n- The new chat starts from an earlier message.",
    };
    expect(recordedFrame("p3-branch-summary", 34)).toMatchObject({
      id: "rpc-5",
      type: "response",
      command: "get_entries",
      success: true,
      data: { entries: expect.arrayContaining([summary]), leafId: "0796c2ca" },
    });
    expect(BRANCH_SUMMARY_ENTRY).toBe("0796c2ca");
    expect(BRANCH_SUMMARY_FROM_ID).toBe("c1139e17");
    expect(BRANCH_SUMMARY_TEXT).toBe(summary.summary);
  });

  test("provider prompt_result keeps its error status, request id and retryable details", () => {
    const expected = {
      type: "prompt_result",
      id: "rpc-2",
      agentInvoked: true,
      status: "error",
      sessionSettled: true,
      error: {
        message:
          "503 fake provider retry failure\nfake provider retry failure (type=server_error param=service_unavailable)",
        provider: "fake",
        model: "fake-model",
        retryable: true,
        httpStatus: 503,
      },
    };
    expect(recordedFrame("p3-provider-error", 41)).toEqual(expected);
    expect(promptErrorRecorded()).toEqual(expected);
  });
});

describe("other recorded fixture values used by P3", () => {
  test("the stored assistant answer is the message recorded at prompt-stream line 14, usage included", () => {
    expect(recordedFrame("prompt-stream", 14)).toMatchObject({
      type: "message_start",
      message: storedAssistant(ASSISTANT_ANSWER, USER_WITH_IMAGE).message,
    });
  });

  test("completed and aborted prompt results and the settled frame match their expected statuses", () => {
    const completed = {
      type: "prompt_result",
      id: "rpc-2",
      agentInvoked: true,
      status: "completed",
      sessionSettled: true,
    };
    const aborted = {
      type: "prompt_result",
      id: "rpc-2",
      agentInvoked: true,
      status: "aborted",
      sessionSettled: true,
    };
    const settled = { type: "session_settled" };
    expect(recordedFrame("prompt-stream", 38)).toEqual(completed);
    expect(promptCompleted()).toEqual(completed);
    expect(recordedFrame("abort", 23)).toEqual(aborted);
    expect(promptAborted()).toEqual(aborted);
    expect(recordedFrame("abort", 24)).toEqual(settled);
    expect(SESSION_SETTLED).toEqual(settled);
  });

  test("a stored user message keeps the recorded user envelope at prompt-stream line 13", () => {
    expect(recordedFrame("prompt-stream", 13)).toMatchObject({
      message: { role: "user", attribution: "user" },
    });
    expect(storedUserText(USER_TEXT_ONLY, null, "Earlier question").message).toMatchObject({
      role: "user",
      attribution: "user",
    });
  });
});
