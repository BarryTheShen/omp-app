import type { ShareOutcome } from "./controller";

/** One plain-English sentence for a finished share, for the status line under the chat. */
export function describeShareOutcome(outcome: ShareOutcome): string {
  switch (outcome.outcome) {
    case "copied":
      return "Share link copied. Anyone with the link can read this chat.";
    case "shown-for-manual-copy":
      return "Share link shown so you can copy it by hand.";
    case "link-not-copied":
      return "Share link made, but not copied. Share again to make a new link.";
    case "not-shared":
      return "Nothing was shared.";
    case "failed":
      return outcome.error.message;
  }
}
