/**
 * What the copy picker finished with. "copied" is reported only after the clipboard accepted the text.
 * "download-started" and "shown-for-manual-copy" are reported only after the recovery the user chose ran;
 * they never claim the clipboard was written.
 */
export type CopyPickerOutcome =
  | { readonly outcome: "copied"; readonly label: string; readonly chars: number }
  | {
      readonly outcome: "download-started";
      readonly label: string;
      readonly fileName: string;
      readonly chars: number;
    }
  | { readonly outcome: "shown-for-manual-copy"; readonly label: string; readonly chars: number }
  | { readonly outcome: "not-copied"; readonly reason: string }
  | { readonly outcome: "nothing-to-copy" }
  | { readonly outcome: "cancelled" };

/** One plain-English sentence for the outcome, for the status line under the chat. */
export function describeCopyOutcome(outcome: CopyPickerOutcome): string {
  switch (outcome.outcome) {
    case "copied":
      return `Copied "${outcome.label}" (${characters(outcome.chars)}).`;
    case "download-started":
      return `Download requested for ${outcome.fileName} (${characters(outcome.chars)}). Nothing was copied to the clipboard.`;
    case "shown-for-manual-copy":
      return `Showed "${outcome.label}" (${characters(outcome.chars)}) so you can copy it by hand. Nothing was copied to the clipboard.`;
    case "not-copied":
      return `Nothing was copied. ${outcome.reason}`;
    case "nothing-to-copy":
      return "Nothing to copy in this chat yet.";
    case "cancelled":
      return "Nothing was copied.";
  }
}

function characters(count: number): string {
  return count === 1 ? "1 character" : `${count} characters`;
}
