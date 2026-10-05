import { Cursor, FolderPath } from "@omp-app/contracts";
import { z } from "zod";

/** The normal sidebar scope: only native sessions whose omp header cwd is this folder. */
export const FolderSessionScope = z.strictObject({
  kind: z.literal("folder"),
  folder: FolderPath,
});
export type FolderSessionScope = z.infer<typeof FolderSessionScope>;

/** The explicit project scope: repository root and its linked worktree roots/descendants. */
export const ProjectSessionScope = z.strictObject({
  kind: z.literal("project"),
  folder: FolderPath,
  repositoryRoot: FolderPath,
});
export type ProjectSessionScope = z.infer<typeof ProjectSessionScope>;

export const SessionScope = z.discriminatedUnion("kind", [FolderSessionScope, ProjectSessionScope]);
export type SessionScope = z.infer<typeof SessionScope>;

export const SessionScopeKind = z.enum(["folder", "project"]);
export type SessionScopeKind = z.infer<typeof SessionScopeKind>;

/** Origin shown in the catalog; imported sources are explicit, never silently mounted. */
export const SessionProvenance = z.enum(["native", "claude", "codex", "omp-share"]);
export type SessionProvenance = z.infer<typeof SessionProvenance>;

/** Client-side text and scope filters; the server still applies the scope through A1. */
export const SessionCatalogFilter = z.strictObject({
  scope: SessionScope,
  query: z.string().max(512).default(""),
});
export type SessionCatalogFilter = z.infer<typeof SessionCatalogFilter>;

/** Opaque A1 cursor plus the filter that produced it; cursors are never interpreted in R1. */
export const SessionCatalogPageArgs = z.strictObject({
  filter: SessionCatalogFilter,
  cursor: Cursor.optional(),
  limit: z.int().min(1).max(100).default(50),
});
export type SessionCatalogPageArgs = z.infer<typeof SessionCatalogPageArgs>;
