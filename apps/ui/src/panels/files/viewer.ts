/**
 * Which viewer opens a file in the Files panel (#2782), from the media type the server names and the file's size. The
 * limits are the issue's: text editable up to 2 MiB, read-only to 20 MiB (the first 2 MiB, then Load all), past that
 * download only; images to 50 MiB; PDF, audio and video to 100 MiB; HTML to 5 MiB. A file of unknown type up to
 * 2 MiB is tried as text, and shown as text only when it is valid UTF-8.
 */
export type ViewerKind =
  | "text"
  | "markdown"
  | "html"
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "other";

export interface ViewerChoice {
  readonly kind: ViewerKind;
  /** Text that can be edited and saved. */
  readonly editable: boolean;
  /** Only the first `TEXT_EDIT_BYTES` are read at first; Load all reads the rest. */
  readonly partial: boolean;
  /** A file of unknown type, shown as text only if it decodes as UTF-8. */
  readonly sniff: boolean;
}

const MIB = 1024 * 1024;
export const TEXT_EDIT_BYTES = 2 * MIB;
export const TEXT_VIEW_BYTES = 20 * MIB;
export const IMAGE_BYTES = 50 * MIB;
export const MEDIA_BYTES = 100 * MIB;
export const HTML_BYTES = 5 * MIB;

const TEXT_APPLICATION_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/x-ndjson",
  "application/x-ipynb+json",
  "application/xml",
  "application/toml",
]);
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/svg+xml",
]);

const choice = (
  kind: ViewerKind,
  editable = false,
  partial = false,
  sniff = false,
): ViewerChoice => ({
  kind,
  editable,
  partial,
  sniff,
});
const OTHER = choice("other");

/** Text and its limits: editable, read-only from the start, or download only. */
function asText(kind: "text" | "markdown", size: number, sniff = false): ViewerChoice {
  if (size <= TEXT_EDIT_BYTES) return choice(kind, true, false, sniff);
  if (size <= TEXT_VIEW_BYTES && !sniff) return choice(kind, false, true);
  return OTHER;
}

export function chooseViewer(mediaType: string, size: number): ViewerChoice {
  const type = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "text/markdown") return asText("markdown", size);
  if (type === "text/html") return size <= HTML_BYTES ? choice("html", true) : OTHER;
  if (type.startsWith("text/") || TEXT_APPLICATION_TYPES.has(type)) return asText("text", size);
  if (IMAGE_TYPES.has(type)) return size <= IMAGE_BYTES ? choice("image") : OTHER;
  if (type === "application/pdf") return size <= MEDIA_BYTES ? choice("pdf") : OTHER;
  if (type.startsWith("audio/")) return size <= MEDIA_BYTES ? choice("audio") : OTHER;
  if (type.startsWith("video/")) return size <= MEDIA_BYTES ? choice("video") : OTHER;
  return asText("text", size, true);
}

/** Text from bytes when they are valid UTF-8; null when they are not (a binary file). */
export function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
