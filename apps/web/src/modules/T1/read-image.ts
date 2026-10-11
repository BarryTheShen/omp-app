import { z } from "zod";

/**
 * Largest image, in decoded bytes, that a read card draws. A bigger image gets a plain note instead,
 * so one read cannot make the transcript hold megabytes of picture data.
 */
export const READ_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/** The picture types a card draws as an `<img>`: raster formats only, so no script can run in one. */
const SHOWN_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Canonical base64: a length of whole four-character groups, with at most two "=" at the end. The
 * characters are checked with one flat pattern: a pattern that repeats each group overflows the regex
 * stack on a picture of a few megabytes.
 */
const BASE64_CHARACTERS = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * What a read card can do with one image part omp returned. `not-loaded` is a `blob:` reference the
 * history window kept because its saved copy is over the limit or missing.
 */
export type ReadImagePreview =
  | { readonly kind: "shown"; readonly src: string }
  | { readonly kind: "too-large"; readonly bytes: number }
  | { readonly kind: "not-loaded" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "unreadable" };

const ResultContent = z.looseObject({ content: z.array(z.unknown()).optional() });
const ImagePart = z.looseObject({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});

/**
 * The image parts omp put in a read result, one preview each. The source is built only from the
 * base64 omp sent and an allowed picture type. Nothing is fetched, and no URL in the result is used.
 */
export function readImagePreviews(result: unknown): readonly ReadImagePreview[] {
  const parsed = ResultContent.safeParse(result);
  if (!parsed.success) return [];
  return (parsed.data.content ?? []).flatMap((part) => {
    const image = ImagePart.safeParse(part);
    return image.success ? [previewOf(image.data)] : [];
  });
}

function previewOf(part: { readonly data: string; readonly mimeType: string }): ReadImagePreview {
  const mimeType = part.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!SHOWN_IMAGE_TYPES.has(mimeType)) return { kind: "unsupported" };
  if (part.data.startsWith("blob:")) return { kind: "not-loaded" };
  if (part.data === "") return { kind: "unreadable" };
  const bytes = decodedBytes(part.data);
  if (bytes > READ_IMAGE_MAX_BYTES) return { kind: "too-large", bytes };
  if (part.data.length % 4 !== 0 || !BASE64_CHARACTERS.test(part.data)) {
    return { kind: "unreadable" };
  }
  return { kind: "shown", src: `data:${mimeType};base64,${part.data}` };
}

/** The number of bytes a base64 string decodes to (exact for canonical base64, an estimate otherwise). */
function decodedBytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}
