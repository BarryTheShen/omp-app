import { describe, expect, test } from "vitest";
import { describeCopyOutcome } from "./outcome";

describe("describeCopyOutcome", () => {
  test("reports a copy with the target's label and the characters written", () => {
    expect(
      describeCopyOutcome({ outcome: "copied", label: "Code block 1 in message 1", chars: 18 }),
    ).toBe('Copied "Code block 1 in message 1" (18 characters).');
    expect(describeCopyOutcome({ outcome: "copied", label: "Latest code", chars: 1 })).toBe(
      'Copied "Latest code" (1 character).',
    );
  });

  test("says a download was requested, not that the clipboard was written", () => {
    expect(
      describeCopyOutcome({
        outcome: "download-started",
        label: "Code block 1 in message 1",
        fileName: "code-block-1-in-message-1.txt",
        chars: 18,
      }),
    ).toBe(
      "Download requested for code-block-1-in-message-1.txt (18 characters). Nothing was copied to the clipboard.",
    );
  });

  test("says the text was shown for a copy by hand, and that nothing was copied", () => {
    expect(
      describeCopyOutcome({
        outcome: "shown-for-manual-copy",
        label: "Command 1 in message 1",
        chars: 11,
      }),
    ).toBe(
      'Showed "Command 1 in message 1" (11 characters) so you can copy it by hand. Nothing was copied to the clipboard.',
    );
  });

  test("says why nothing was copied when a copy failed", () => {
    expect(
      describeCopyOutcome({
        outcome: "not-copied",
        reason: "The clipboard refused the copy, so nothing was saved.",
      }),
    ).toBe("Nothing was copied. The clipboard refused the copy, so nothing was saved.");
  });

  test("says a chat with nothing copyable has nothing to copy, and a cancel copied nothing", () => {
    expect(describeCopyOutcome({ outcome: "nothing-to-copy" })).toBe(
      "Nothing to copy in this chat yet.",
    );
    expect(describeCopyOutcome({ outcome: "cancelled" })).toBe("Nothing was copied.");
  });
});
