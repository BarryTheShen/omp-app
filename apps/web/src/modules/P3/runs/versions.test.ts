import { EntryId, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { lastSavedUserEntryId, otherVersionsFor, type SessionVersionCandidate } from "./versions";

const sourceFile = "/workspace/chat/source.jsonl" as SessionVersionCandidate["sessionFile"];
const original = ThreadId.parse("original");

function session(
  id: string,
  createdAt: string,
  parentSession: SessionVersionCandidate["parentSession"],
  title: string,
): SessionVersionCandidate {
  return {
    id: ThreadId.parse(id),
    sessionFile: `/workspace/chat/${id}.jsonl` as SessionVersionCandidate["sessionFile"],
    parentSession,
    title,
    displayTitle: title,
    firstPrompt: null,
    createdAt,
  };
}

describe("otherVersionsFor", () => {
  test("lists the original and edited siblings oldest first, using displayTitle instead of stored card text", () => {
    const sessions = [
      {
        ...session("newer", "2026-01-03T00:00:00.000Z", sourceFile, "Newer edit"),
        title: "🧪 ABC: Newer edit",
      },
      {
        ...session("original", "2026-01-01T00:00:00.000Z", null, "Original"),
        sessionFile: sourceFile,
      },
      session("older", "2026-01-02T00:00:00.000Z", sourceFile, "Older edit"),
    ];

    expect(otherVersionsFor(sessions, original)).toEqual([
      { threadId: ThreadId.parse("older"), title: "Older edit" },
      { threadId: ThreadId.parse("newer"), title: "Newer edit" },
    ]);
  });

  test("shows the original and other siblings when the current chat is an edit", () => {
    const sessions = [
      {
        ...session("original", "2026-01-01T00:00:00.000Z", null, "Original"),
        sessionFile: sourceFile,
      },
      session("edited", "2026-01-02T00:00:00.000Z", sourceFile, "Edited"),
      session("other", "2026-01-03T00:00:00.000Z", sourceFile, "Other"),
    ];

    expect(otherVersionsFor(sessions, ThreadId.parse("edited"))).toEqual([
      { threadId: original, title: "Original" },
      { threadId: ThreadId.parse("other"), title: "Other" },
    ]);
  });

  test("returns no versions when the current chat is absent from the catalog", () => {
    expect(otherVersionsFor([], original)).toEqual([]);
  });

  test("excludes unrelated chats", () => {
    const sessions = [
      {
        ...session("original", "2026-01-01T00:00:00.000Z", null, "Original"),
        sessionFile: sourceFile,
      },
      session("edited", "2026-01-02T00:00:00.000Z", sourceFile, "Edited"),
      session("unrelated", "2026-01-03T00:00:00.000Z", null, "Unrelated"),
    ];

    expect(otherVersionsFor(sessions, original)).toEqual([
      { threadId: ThreadId.parse("edited"), title: "Edited" },
    ]);
  });

  test("falls back from display title to first prompt and then to Other chat", () => {
    const sessions = [
      {
        ...session("original", "2026-01-01T00:00:00.000Z", null, "Original"),
        sessionFile: sourceFile,
      },
      {
        ...session("display", "2026-01-02T00:00:00.000Z", sourceFile, "Stored title"),
        displayTitle: null,
        firstPrompt: "First prompt",
      },
      {
        ...session("fallback", "2026-01-03T00:00:00.000Z", sourceFile, "Stored title"),
        displayTitle: null,
      },
    ];

    expect(otherVersionsFor(sessions, original)).toEqual([
      { threadId: ThreadId.parse("display"), title: "First prompt" },
      { threadId: ThreadId.parse("fallback"), title: "Other chat" },
    ]);
  });

  test("a display title wins over the first prompt when a chat has both", () => {
    const sessions = [
      {
        ...session("original", "2026-01-01T00:00:00.000Z", null, "Original"),
        sessionFile: sourceFile,
      },
      {
        ...session("both", "2026-01-02T00:00:00.000Z", sourceFile, "Stored title"),
        displayTitle: "Chosen title",
        firstPrompt: "A long first prompt",
      },
    ];

    expect(otherVersionsFor(sessions, original)).toEqual([
      { threadId: ThreadId.parse("both"), title: "Chosen title" },
    ]);
  });

  test("does not group an id-only fork marker with file-based edited siblings", () => {
    const sessions = [
      {
        ...session("original", "2026-01-01T00:00:00.000Z", null, "Original"),
        sessionFile: sourceFile,
      },
      session("edited", "2026-01-02T00:00:00.000Z", sourceFile, "Edited"),
      session(
        "fork",
        "2026-01-03T00:00:00.000Z",
        "original" as SessionVersionCandidate["parentSession"],
        "Fork",
      ),
    ];

    expect(otherVersionsFor(sessions, original)).toEqual([
      { threadId: ThreadId.parse("edited"), title: "Edited" },
    ]);
  });
});

describe("lastSavedUserEntryId", () => {
  test("returns the last user row with an entry id", () => {
    const first = EntryId.parse("entry-first");
    const second = EntryId.parse("entry-second");
    expect(
      lastSavedUserEntryId([
        { role: "user", entryId: first },
        { role: "assistant", entryId: EntryId.parse("entry-answer") },
        { role: "user", entryId: second },
      ]),
    ).toBe(second);
  });

  test("skips an unsaved last user row", () => {
    const prior = EntryId.parse("entry-first");
    expect(
      lastSavedUserEntryId([
        { role: "user", entryId: prior },
        { role: "user", entryId: null },
      ]),
    ).toBe(prior);
  });

  test("returns null when there are no user rows", () => {
    expect(
      lastSavedUserEntryId([{ role: "assistant", entryId: EntryId.parse("entry-answer") }]),
    ).toBeNull();
  });
});
