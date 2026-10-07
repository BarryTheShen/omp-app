import { describe, expect, test } from "vitest";
import { applyTranscriptPage, EMPTY_TRANSCRIPT_TAIL, requestOffset } from "../tail";
import {
  assistantMessage,
  firstFile,
  hiddenMessage,
  replacedFile,
  transcriptPage,
  userMessage,
} from "./fixtures";

function readTwoMessages() {
  const first = applyTranscriptPage(
    EMPTY_TRANSCRIPT_TAIL,
    transcriptPage({ fromByte: 0, nextByte: 40, messages: [userMessage("one")] }),
    0,
  );
  return applyTranscriptPage(
    first,
    transcriptPage({ fromByte: 40, nextByte: 90, messages: [assistantMessage("two")] }),
    40,
  );
}

describe("the byte cursor", () => {
  test("a fresh tail reads from byte zero, and a worker whose recorded file moved starts again at zero", () => {
    expect(requestOffset(EMPTY_TRANSCRIPT_TAIL, firstFile)).toBe(0);
    const reading = applyTranscriptPage(
      EMPTY_TRANSCRIPT_TAIL,
      transcriptPage({ fromByte: 0, nextByte: 40, messages: [userMessage("hi")] }),
      0,
    );
    expect(requestOffset(reading, firstFile)).toBe(40);
    expect(requestOffset(reading, replacedFile)).toBe(0);
  });

  test("a continuation appends only the new messages and keeps the ids the earlier ones had", () => {
    const state = readTwoMessages();
    expect(state.messages.map((message) => message.id)).toEqual(["omp-message-0", "omp-message-1"]);
    expect(state.cursor).toBe(90);
    expect(state.rawCount).toBe(2);
  });

  test("a page with no new complete records returns the same state object, so nothing re-renders", () => {
    const state = readTwoMessages();
    expect(applyTranscriptPage(state, transcriptPage({ fromByte: 90, nextByte: 90 }), 90)).toBe(
      state,
    );
  });

  test("a reset from omp replaces what was shown with the page it sent", () => {
    const reset = applyTranscriptPage(
      readTwoMessages(),
      transcriptPage({ fromByte: 0, nextByte: 30, messages: [userMessage("fresh")], reset: true }),
      90,
    );
    expect(reset.messages).toHaveLength(1);
    expect(reset.cursor).toBe(30);
  });

  test("a page that starts mid-file without being a continuation drops the cursor and keeps the shown messages", () => {
    const state = readTwoMessages();
    const unplaced = applyTranscriptPage(
      state,
      transcriptPage({ fromByte: 25, nextByte: 60, messages: [assistantMessage("x")] }),
      40,
    );
    expect(unplaced.messages).toBe(state.messages);
    expect(unplaced.sessionFile).toBeUndefined();
    expect(requestOffset(unplaced, firstFile)).toBe(0);
  });

  test("a recorded file that changed is read from its first byte, and replaces the old transcript", () => {
    const moved = applyTranscriptPage(
      readTwoMessages(),
      transcriptPage({
        file: replacedFile,
        fromByte: 0,
        nextByte: 20,
        messages: [userMessage("new file")],
      }),
      0,
    );
    expect(moved.sessionFile).toBe(replacedFile);
    expect(moved.messages).toHaveLength(1);
  });

  test("a hidden message keeps its place in the numbering without adding a row", () => {
    const state = applyTranscriptPage(
      EMPTY_TRANSCRIPT_TAIL,
      transcriptPage({
        fromByte: 0,
        nextByte: 60,
        messages: [hiddenMessage(), userMessage("shown")],
      }),
      0,
    );
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.id).toBe("omp-message-1");
    expect(state.rawCount).toBe(2);
  });
});
