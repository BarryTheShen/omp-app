import { describe, expect, test } from "vitest";
import type { TriggerCandidate } from "../contract";
import {
  detectEmojiTrigger,
  detectInternalUrlTrigger,
  expandEmoji,
  expandEmoticons,
  expandInternalUrl,
} from "../local";

describe("local expansion through D2.5's functions", () => {
  test("a typed emoji name expands to the chosen character, and the cursor lands after it", () => {
    const text = "hi :sm";
    const match = detectEmojiTrigger(text, text.length);
    if (match === null) throw new Error("the emoji trigger was not detected");
    const candidate: TriggerCandidate = {
      id: "emoji:smile",
      kind: "emoji",
      source: "client",
      label: "smile",
      insertText: "😄",
    };
    expect(expandEmoji(text, match, candidate)).toEqual({
      kind: "expanded",
      text: "hi 😄",
      replace: match.range,
      cursor: "hi 😄".length,
      attachmentRefs: [],
    });
  });

  test("an emoji typed inside a code span is refused: the result is an error that keeps the typed text", () => {
    const text = "`:sm`";
    const match = { prefix: ":", query: "sm", range: { start: 1, end: 4 } };
    const candidate: TriggerCandidate = {
      id: "emoji:smile",
      kind: "emoji",
      source: "client",
      label: "smile",
      insertText: "😄",
    };
    expect(expandEmoji(text, match, candidate)).toEqual({
      kind: "error",
      error: {
        code: "invalid_args",
        message: "Emoji expansion is disabled inside code.",
        retryable: false,
      },
      replace: match.range,
      preserveText: true,
    });
  });

  test("a terminated emoticon is replaced, and one inside a code span is kept", () => {
    expect(expandEmoticons("hi :) there")).toBe("hi 🙂 there");
    expect(expandEmoticons("`:)` stays")).toBe("`:)` stays");
  });

  test("an internal URL with a known scheme expands to the candidate, and the cursor follows it", () => {
    const text = "see skill://ta";
    const match = detectInternalUrlTrigger(text, text.length);
    if (match === null) throw new Error("the internal URL trigger was not detected");
    const candidate: TriggerCandidate = {
      id: "skill://tasks",
      kind: "internal-url",
      source: "a1.url-catalog",
      label: "tasks",
      insertText: "skill://tasks",
    };
    expect(expandInternalUrl(text, match, candidate)).toEqual({
      kind: "expanded",
      text: "see skill://tasks",
      replace: match.range,
      cursor: "see skill://tasks".length,
      attachmentRefs: [],
    });
  });

  test("an internal URL inside a code span is refused, and the text is kept", () => {
    const text = "`skill://ta`";
    const match = { scheme: "skill", query: "ta", range: { start: 1, end: 11 } };
    const candidate: TriggerCandidate = {
      id: "skill://tasks",
      kind: "internal-url",
      source: "a1.url-catalog",
      label: "tasks",
      insertText: "skill://tasks",
    };
    expect(expandInternalUrl(text, match, candidate)).toEqual({
      kind: "error",
      error: {
        code: "invalid_args",
        message: "Internal URL expansion is disabled inside code.",
        retryable: false,
      },
      replace: match.range,
      preserveText: true,
    });
  });

  test("a scheme omp does not register opens no trigger, so its text stays plain", () => {
    expect(detectInternalUrlTrigger("see nope://x", "see nope://x".length)).toBeNull();
  });
});
