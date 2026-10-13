import type { FileMention } from "../rows";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? Reflect.get(value, key)
    : undefined;
}

function fileOf(item: unknown): readonly FileMention[] {
  const path = field(item, "path");
  if (typeof path !== "string" || path === "") return [];
  const lineCount = field(item, "lineCount");
  const image = field(item, "image");
  const skippedReason = field(item, "skippedReason");
  return [
    {
      path,
      ...(typeof lineCount === "number" && Number.isFinite(lineCount) ? { lineCount } : {}),
      ...(typeof image === "object" && image !== null ? { image: true } : {}),
      ...(skippedReason === "tooLarge" || skippedReason === "binary" ? { skippedReason } : {}),
    },
  ];
}

/**
 * The file rows of one of omp's `fileMention` messages, read from the message R0 keeps in the row's
 * metadata. Each file is checked field by field: an entry without a path is dropped, and a skip reason
 * omp does not use is ignored, so the file still shows with its line count or image marker.
 */
export function fileMentionFilesOf(message: unknown): readonly FileMention[] {
  const files = field(message, "files");
  return Array.isArray(files) ? files.flatMap(fileOf) : [];
}
