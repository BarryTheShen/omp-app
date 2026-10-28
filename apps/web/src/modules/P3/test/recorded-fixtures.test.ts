import { describe, expect, test } from "vitest";
import {
  recordedChatEvents,
  recordedResults,
  type SessionRecording,
} from "@/modules/R0/fixtures/recorded-session";
import { PROMPT_STREAM } from "@/modules/R0/fixtures/recordings";
import { ASSISTANT_ANSWER, storedAssistant, USER_WITH_IMAGE } from "../fixtures/omp-branch";
import { P3_BRANCH_IMAGE } from "../fixtures/recordings";

/** The `message` of each recorded chat event of `type`, in order. */
function messagesOf(recording: SessionRecording, type: string): { readonly role?: unknown }[] {
  return recordedChatEvents(recording, type).map((event) =>
    event.kind === "event" ? ((event.event as { message?: { role?: unknown } }).message ?? {}) : {},
  );
}

describe("what omp recorded for P3", () => {
  test("an image-only user message is recorded, while get_branch_messages leaves it out", () => {
    expect(messagesOf(P3_BRANCH_IMAGE, "message_start")).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "image", data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" },
        ],
      }),
    );
    expect(recordedResults(P3_BRANCH_IMAGE, "get_branch_messages")).toEqual([{ messages: [] }]);
  });

  test("the stored assistant answer is the assistant message prompt-stream records, usage included", () => {
    const recorded = messagesOf(PROMPT_STREAM, "message_start").find(
      (message) => message.role === "assistant",
    );
    expect(recorded).toMatchObject(storedAssistant(ASSISTANT_ANSWER, USER_WITH_IMAGE).message);
  });
});
