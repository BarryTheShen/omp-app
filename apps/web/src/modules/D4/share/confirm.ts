import { SHARE_VISIBILITY } from "./visibility";

/**
 * The share settings omp reads when `/share` runs (`commands/settings.ts:8-54`), as their effective values for
 * the open chat's folder.
 */
export interface ShareSettings {
  /** Where the sealed chat is uploaded, and the base of the link. */
  readonly serverUrl: string;
  /** "blob" uploads to the share server; "gist" creates a secret GitHub gist first, then falls back to the server. */
  readonly store: "blob" | "gist";
  /** When true, omp replaces the secrets it knows before the upload. */
  readonly redactSecrets: boolean;
}

export interface ShareConfirmation {
  readonly title: string;
  readonly message: string;
}

/**
 * The question asked before anything leaves this computer: what is uploaded, where it goes, whether secrets are
 * replaced first, and what the link allows. It is built from the settings in force when the person asks.
 */
export function describeShareConfirmation(settings: ShareSettings): ShareConfirmation {
  const redaction = settings.redactSecrets
    ? "Secret redaction is on, so secrets that omp knows about are replaced before the upload."
    : "Secret redaction is off, so secrets in this chat are uploaded as they are.";
  return {
    title: "Share this chat as a link?",
    message: [
      "This sends the whole chat off this computer: your messages, omp's replies, tool output, the text of files the chat mentions, and omp's instructions for this chat.",
      destinationSentence(settings),
      redaction,
      `${SHARE_VISIBILITY.reason} A link cannot be taken back.`,
    ].join(" "),
  };
}

function destinationSentence({ serverUrl, store }: ShareSettings): string {
  if (store === "gist") {
    return `It is encrypted and uploaded as a secret GitHub gist under your GitHub account. If that fails, it is uploaded to ${serverUrl} instead.`;
  }
  return `It is encrypted and uploaded to ${serverUrl}.`;
}
