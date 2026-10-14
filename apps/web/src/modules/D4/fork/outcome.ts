import type { ImportFailure, ImportOutcome, ImportRefusal } from "./controller";

const REFUSED: Record<ImportRefusal, string> = {
  "no-folder": "Open a chat in a folder first, so the imported chat has a folder.",
  "empty-link": "Paste the share link first. It starts with https://.",
  "bad-link": "That is not a share link. Share links start with https://.",
  unsupported:
    "omp can't import shared chats in this version, so no chat was made. The shared chat was not changed.",
};

const FAILED: Record<ImportFailure, string> = {
  unreachable:
    "Couldn't reach the shared chat. Check the link and your connection, then try again. No chat was made.",
  "omp-error": "omp couldn't import the shared chat. No chat was made. Try again.",
  unexpected: "The shared chat could not be imported for an unexpected reason. No chat was made.",
};

/** One plain-English sentence for a finished import, for the status line under the chat. */
export function describeImportOutcome(outcome: ImportOutcome): string {
  switch (outcome.outcome) {
    case "imported":
      return outcome.opened
        ? "Chat imported as a new chat. The shared chat was not changed."
        : "Chat imported as a new chat, but it could not be opened. Find it in the sessions list. The shared chat was not changed.";
    case "imported-with-notes":
      return outcome.opened
        ? "Chat imported as a new chat, but some of it is missing. The shared chat was not changed."
        : "Chat imported as a new chat, but it could not be opened, and some of it is missing. Find it in the sessions list. The shared chat was not changed.";
    case "not-imported":
      return "Nothing was imported.";
    case "refused":
      return REFUSED[outcome.why];
    case "failed":
      return FAILED[outcome.why];
  }
}
