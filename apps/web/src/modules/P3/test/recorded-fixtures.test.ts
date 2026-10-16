// A fixture that stands for a recorded frame must agree with that frame, so a drifted value fails here and not in a test
// that only happens to pass. The recordings are omp 18.6.1 output (packages/omp-rpc/fixtures).
import { describe, expect, test } from "vitest";
import {
  ASSISTANT_ANSWER,
  promptAborted,
  promptCompleted,
  recordedFrame,
  SESSION_SETTLED,
  storedAssistant,
  storedUserText,
  USER_TEXT_ONLY,
  USER_WITH_IMAGE,
} from "../fixtures/omp-branch";

describe("recorded fixtures: each value that stands for a recorded frame matches that frame", () => {
  test("the stored assistant answer is the message recorded at prompt-stream line 14, usage included", () => {
    expect(recordedFrame("prompt-stream", 14)).toMatchObject({
      type: "message_start",
      message: storedAssistant(ASSISTANT_ANSWER, USER_WITH_IMAGE).message,
    });
  });

  test("the completed and aborted prompt results and the settled frame are the recorded ones", () => {
    expect(recordedFrame("prompt-stream", 38)).toMatchObject(promptCompleted());
    expect(recordedFrame("abort", 23)).toMatchObject(promptAborted());
    expect(recordedFrame("abort", 24)).toMatchObject(SESSION_SETTLED);
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

  test("the get_state answer after a branch carries a sessionId, as the recorded one does", () => {
    expect(recordedFrame("out-of-order", 10)).toMatchObject({
      data: { sessionId: expect.any(String) },
    });
  });
});
