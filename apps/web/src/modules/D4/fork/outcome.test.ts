import { ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ShareImportResultDto } from "../contract";
import type { ImportOutcome } from "./controller";
import { describeImportOutcome } from "./outcome";

const RESULT: ShareImportResultDto = {
  threadId: ThreadId.parse("0b2b2b2b-ea99-72dd-a84a-017f5d3766ef"),
  artifactStatus: "preserved",
  artifactWarnings: [],
};

/** Every outcome the flow can end in, with each reason it can carry. */
const EVERY_OUTCOME: readonly ImportOutcome[] = [
  { outcome: "imported", result: RESULT, opened: true },
  { outcome: "imported", result: RESULT, opened: false },
  { outcome: "imported-with-notes", result: RESULT, opened: true },
  { outcome: "imported-with-notes", result: RESULT, opened: false },
  { outcome: "not-imported" },
  { outcome: "refused", why: "no-folder" },
  { outcome: "refused", why: "empty-link" },
  { outcome: "refused", why: "bad-link" },
  { outcome: "refused", why: "unsupported" },
  {
    outcome: "failed",
    why: "unreachable",
    error: { code: "unavailable", message: "x", retryable: true },
  },
  {
    outcome: "failed",
    why: "omp-error",
    error: { code: "omp_error", message: "x", retryable: true },
  },
  {
    outcome: "failed",
    why: "unexpected",
    error: { code: "internal", message: "x", retryable: false },
  },
];

describe("describeImportOutcome", () => {
  test("says a finished import made a new chat and left the shared chat alone", () => {
    expect(describeImportOutcome({ outcome: "imported", result: RESULT, opened: true })).toBe(
      "Chat imported as a new chat. The shared chat was not changed.",
    );
  });

  test("says when the new chat exists but could not be opened, and where to find it", () => {
    expect(describeImportOutcome({ outcome: "imported", result: RESULT, opened: false })).toBe(
      "Chat imported as a new chat, but it could not be opened. Find it in the sessions list. The shared chat was not changed.",
    );
  });

  test("says what is missing when part of the chat did not come across", () => {
    expect(
      describeImportOutcome({ outcome: "imported-with-notes", result: RESULT, opened: true }),
    ).toBe(
      "Chat imported as a new chat, but some of it is missing. The shared chat was not changed.",
    );
  });

  test("says nothing was imported when the person stopped", () => {
    expect(describeImportOutcome({ outcome: "not-imported" })).toBe("Nothing was imported.");
  });

  test("says why omp refused the link, in plain words, and that no chat was made", () => {
    expect(describeImportOutcome({ outcome: "refused", why: "unsupported" })).toBe(
      "omp can't import shared chats in this version, so no chat was made. The shared chat was not changed.",
    );
    expect(describeImportOutcome({ outcome: "refused", why: "bad-link" })).toBe(
      "That is not a share link. Share links start with https://.",
    );
  });

  test("every outcome reads as plain English: no internal names, no raw ids, omp in lowercase", () => {
    const banned =
      /upstream|capability|session-import|session import|RPC|A1\.|D4\.|omp\.cmd|\bOmp\b|sourceKind|omp-share/;
    for (const outcome of EVERY_OUTCOME) {
      const text = describeImportOutcome(outcome);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(banned);
    }
  });
});
