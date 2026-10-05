import { z } from "zod";
import { definePort } from "../../core/envelope";
import { FolderPath, SessionFilePath, ThreadId } from "../../core/ids";

/** Foreign transcript sources that omp can import into a native session. */
export const SessionImportSource = z.enum(["claude", "codex", "omp-share"]);
export type SessionImportSource = z.infer<typeof SessionImportSource>;

/** The source reference is a foreign file path or an omp share URL; it never contains transcript data. */
export const SessionImportArgs = z.strictObject({
  sourceKind: SessionImportSource,
  sourceRef: z.string().trim().min(1).max(4_096),
  folder: FolderPath,
});
export type SessionImportArgs = z.infer<typeof SessionImportArgs>;

/** The result is native omp identity; foreign JSONL never crosses the app wire. */
export const SessionImportResult = z.strictObject({
  threadId: ThreadId,
  sessionFile: SessionFilePath,
  title: z.string().min(1).optional(),
  sourceKind: SessionImportSource,
  sourceShareUrl: z.string().url().max(2_048).optional(),
  artifactStatus: z.enum(["preserved", "unavailable"]),
  artifactWarnings: z.array(z.string().min(1).max(512)).max(32),
});
export type SessionImportResult = z.infer<typeof SessionImportResult>;

/** Imports a supported foreign transcript through an omp-owned import seam. */
export const SessionImportPort = definePort({
  name: "A1.sessionImport",
  methods: {
    import: {
      args: SessionImportArgs,
      result: SessionImportResult,
      capability: "host.session-import",
    },
  },
  events: {},
});
