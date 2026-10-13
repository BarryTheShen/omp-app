import { describe, expect, test } from "vitest";
import {
  aliasTranscriptKey,
  createTranscriptSnapshot,
  derivedRowKey,
  isHiddenSessionEntryType,
  isTranscriptRowVisible,
  resolveMessageKey,
  type TranscriptRow,
  upsertTranscriptRow,
} from "../../model";

function row(messageKey: string, text: string, hidden = false): TranscriptRow {
  return {
    key: messageKey,
    messageKey,
    kind: "message",
    role: "assistant",
    parts: [{ type: "text", text, status: "complete", markdown: true }],
    hidden,
    source: "omp",
  };
}

describe("U1 transcript model", () => {
  test("creates immutable snapshots and replaces one row without changing its key", () => {
    const initial = createTranscriptSnapshot([row("entry:thread:one", "one")]);
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.rows)).toBe(true);
    expect(initial.revision).toBe(0);

    const next = upsertTranscriptRow(initial, row("entry:thread:one", "updated"));
    expect(next.revision).toBe(1);
    expect(next.rows).toHaveLength(1);
    expect(next.rows[0]?.parts[0]).toMatchObject({ text: "updated" });
    expect(initial.rows[0]?.parts[0]).toMatchObject({ text: "one" });
  });

  test("aliases provisional keys to persisted keys and deduplicates the row", () => {
    const provisional = createTranscriptSnapshot([
      row("stream:process:msg-1", "streaming"),
      row("entry:thread:entry-1", "persisted"),
    ]);
    const paired = aliasTranscriptKey(provisional, "stream:process:msg-1", "entry:thread:entry-1");

    expect(resolveMessageKey(paired, "stream:process:msg-1")).toBe("entry:thread:entry-1");
    expect(paired.rows[0]?.parts[0]).toMatchObject({ text: "persisted" });
    expect(paired.rows[0]?.messageKey).toBe("entry:thread:entry-1");
    expect(paired.aliases["stream:process:msg-1"]).toBe("entry:thread:entry-1");
  });

  test("keeps hidden metadata in the model while suppressing its DOM row", () => {
    const hidden = row("entry:thread:metadata", "", true);
    expect(isTranscriptRowVisible(hidden)).toBe(false);
    expect(isTranscriptRowVisible(row("entry:thread:visible", "visible"))).toBe(true);
    expect(isHiddenSessionEntryType("model_change")).toBe(true);
    expect(isHiddenSessionEntryType("message")).toBe(false);
    expect(derivedRowKey("entry:thread:one", "status")).toBe("row:status:entry:thread:one");
  });
});
