import { z } from "zod";
import { definePort } from "../../core/envelope";
import { FolderPath } from "../../core/ids";

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

/** A normalized path relative to the searched workspace folder. */
export const WorkspaceRelativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => !path.includes("\0"), "path must not contain NUL")
  .refine(
    (path) =>
      path !== "." &&
      !path.startsWith("/") &&
      !WINDOWS_ABSOLUTE_PATH.test(path) &&
      !path.split(/[\\/]/).some((segment) => segment === ".." || segment === "."),
    "path must be relative to the workspace",
  );
export type WorkspaceRelativePath = z.infer<typeof WorkspaceRelativePath>;

export const FileSearchKind = z.enum(["file", "directory"]);
export type FileSearchKind = z.infer<typeof FileSearchKind>;

/** One ignore-aware path candidate; file contents never cross this port. */
export const FileSearchCandidate = z.strictObject({
  path: WorkspaceRelativePath,
  kind: FileSearchKind,
  score: z.number().finite().nonnegative(),
});
export type FileSearchCandidate = z.infer<typeof FileSearchCandidate>;

export const FileSearchArgs = z.strictObject({
  folder: FolderPath,
  query: z
    .string()
    .max(512)
    .refine((query) => !query.includes("\0"), "query must not contain NUL"),
  limit: z.int().min(1).max(200).optional(),
});
export type FileSearchArgs = z.infer<typeof FileSearchArgs>;

export const FileSearchResult = z.strictObject({
  results: z.array(FileSearchCandidate).max(200),
  /** True when the bounded scan stopped before all workspace entries were inspected. */
  truncated: z.boolean(),
});
export type FileSearchResult = z.infer<typeof FileSearchResult>;

export const FileSearchPort = definePort({
  name: "A1.fileSearch",
  methods: {
    search: {
      args: FileSearchArgs,
      result: FileSearchResult,
      capability: "host.file-search",
    },
  },
  events: {},
});
