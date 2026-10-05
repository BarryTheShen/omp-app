import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type {
  PlanChanged,
  PlanDocumentInput,
  PlanExportResult,
  PlanLoadArgs,
  PlanLoadResult,
  PlanSaveResult,
  ThreadId,
} from "@omp-app/contracts";
import {
  AppFailure,
  PlanDocument,
  PlanExportArgs,
  PlanRevision,
  PlanSaveArgs,
} from "@omp-app/contracts";
import type { FileSnapshot } from "../fs";
import { compareAndSwapFile, ensureAppDataDir, readFileSnapshot } from "../fs";
import { resolveAppDataDir } from "../fs/app-data";

export const DEFAULT_PLAN_HISTORY_LIMIT = 50;
const PLAN_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const MAX_PLAN_FILES = 10_000;

export interface PlanDocumentStoreOptions {
  readonly appDataDir?: string;
  readonly maxHistory?: number;
  readonly now?: () => string;
  readonly onError?: (error: AppFailure) => void;
}

export type PlanChangeListener = (change: PlanChanged) => void | Promise<void>;

export interface PlanDocumentStoreService {
  load(args: PlanLoadArgs): Promise<PlanLoadResult>;
  save(args: PlanSaveArgs): Promise<PlanSaveResult>;
  export(args: PlanExportArgs): Promise<PlanExportResult>;
  subscribe(threadId: ThreadId | null, listener: PlanChangeListener): () => void;
}

type StoredPlan = {
  readonly document: PlanDocument;
  readonly revisions: readonly PlanRevision[];
};

/** Creates one app-owned plan store. It never touches omp's session files. */
export function createPlanDocumentStore(
  options: PlanDocumentStoreOptions = {},
): PlanDocumentStoreService {
  const appDataDir = resolve(options.appDataDir ?? resolveAppDataDir());
  const historyLimit = normalizeHistoryLimit(options.maxHistory);
  const now = options.now ?? (() => new Date().toISOString());
  const listeners = new Set<{
    readonly threadId: ThreadId | null;
    readonly listener: PlanChangeListener;
  }>();

  return {
    async load(args) {
      const file = await readPlanSnapshot(planPath(appDataDir, args.threadId));
      if (!file.exists || file.content === null) return { document: null, revisions: [] };
      const stored = parseStoredPlan(file.content);
      return {
        document: stored.document,
        revisions: stored.revisions.slice(0, historyLimit),
      };
    },

    async save(args) {
      const parsed = PlanSaveArgs.safeParse(args);
      if (!parsed.success) throw invalidArgs("The plan document arguments are invalid.");
      validateDocumentInput(parsed.data.document);
      const { document, expectedRevision } = parsed.data;
      const path = planPath(appDataDir, document.threadId);
      await ensureAppDataDir(appDataDir);
      const currentFile = await readPlanSnapshot(path);
      const current =
        currentFile.exists && currentFile.content !== null
          ? parseStoredPlan(currentFile.content)
          : null;
      const currentRevision = current?.document.revision ?? 0;
      if (expectedRevision !== currentRevision) {
        throw conflictFailure();
      }
      if (current !== null && current.document.id !== document.id) {
        throw invalidArgs("The plan document identity cannot change.");
      }

      const revision = currentRevision + 1;
      const savedAt = now();
      const updated: PlanDocument = {
        ...document,
        revision,
        updatedAt: savedAt,
      };
      const revisions =
        current === null
          ? []
          : [snapshotRevision(current.document, savedAt), ...current.revisions].slice(
              0,
              historyLimit,
            );
      const stored: StoredPlan = { document: updated, revisions };
      const content = `${JSON.stringify(stored, null, 2)}\n`;
      try {
        await compareAndSwapFile(path, content, currentFile.hash);
      } catch (error) {
        if (error instanceof AppFailure && error.appError.code === "conflict") {
          throw conflictFailure();
        }
        throw error;
      }
      const result = { document: updated, revisions };
      await publish({ threadId: updated.threadId, document: updated, revisions });
      return result;
    },

    async export(args) {
      const parsed = PlanExportArgs.safeParse(args);
      if (!parsed.success) throw invalidArgs("The plan export arguments are invalid.");
      const document = await findDocument(appDataDir, parsed.data.documentId);
      if (document === null) throw notFoundFailure();
      const text =
        parsed.data.format === "markdown"
          ? document.markdown
          : `${JSON.stringify(document, null, 2)}\n`;
      return { documentId: document.id, format: parsed.data.format, text };
    },

    subscribe(threadId, listener) {
      const entry = { threadId, listener };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
  };

  async function publish(change: PlanChanged): Promise<void> {
    for (const entry of listeners) {
      if (entry.threadId !== null && entry.threadId !== change.threadId) continue;
      try {
        await entry.listener(change);
      } catch (error) {
        reportObserverError(options.onError, error);
      }
    }
  }
}

function normalizeHistoryLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PLAN_HISTORY_LIMIT;
  return Math.max(1, Math.min(DEFAULT_PLAN_HISTORY_LIMIT, Math.floor(value)));
}

function planPath(appDataDir: string, threadId: ThreadId): string {
  const key = createHash("sha256").update(threadId).digest("hex");
  return join(appDataDir, "plans", `${key}.json`);
}
async function readPlanSnapshot(path: string): Promise<FileSnapshot> {
  try {
    return await readFileSnapshot(path);
  } catch (error) {
    throw toFailure(error);
  }
}

function parseStoredPlan(content: string): StoredPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new AppFailure(
      { code: "internal", message: "The stored plan document is invalid.", retryable: false },
      { cause: error },
    );
  }
  if (typeof raw !== "object" || raw === null || !("document" in raw)) {
    throw new AppFailure({
      code: "internal",
      message: "The stored plan document is invalid.",
      retryable: false,
    });
  }
  const documentResult = PlanDocument.safeParse(raw.document);
  const revisionsValue = "revisions" in raw ? raw.revisions : [];
  const revisionsResult = PlanRevision.array()
    .max(DEFAULT_PLAN_HISTORY_LIMIT)
    .safeParse(revisionsValue);
  if (!documentResult.success || !revisionsResult.success) {
    throw new AppFailure({
      code: "internal",
      message: "The stored plan document is invalid.",
      retryable: false,
    });
  }
  return { document: documentResult.data, revisions: revisionsResult.data };
}

async function findDocument(appDataDir: string, documentId: string): Promise<PlanDocument | null> {
  const directory = join(appDataDir, "plans");
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw toFailure(error);
  }
  let inspected = 0;
  for (const entry of entries) {
    if (inspected >= MAX_PLAN_FILES) throw timeoutFailure();
    if (!entry.isFile() || !PLAN_FILE_PATTERN.test(entry.name)) continue;
    inspected += 1;
    const file = await readPlanSnapshot(join(directory, entry.name));
    if (!file.exists || file.content === null) continue;
    const stored = parseStoredPlan(file.content);
    if (stored.document.id === documentId) return stored.document;
  }
  return null;
}

function validateDocumentInput(document: PlanDocumentInput): void {
  const sectionIds = new Set<string>();
  for (const section of document.sections) {
    if (sectionIds.has(section.id) || section.end < section.start) {
      throw invalidArgs("The plan sections are invalid.");
    }
    sectionIds.add(section.id);
  }
  const annotationIds = new Set<string>();
  for (const annotation of document.annotations) {
    if (annotationIds.has(annotation.id) || !sectionIds.has(annotation.sectionId)) {
      throw invalidArgs("The plan annotations are invalid.");
    }
    annotationIds.add(annotation.id);
  }
}

function snapshotRevision(document: PlanDocument, savedAt: string): PlanRevision {
  return {
    revision: document.revision,
    savedAt,
    markdown: document.markdown,
    sections: document.sections,
    annotations: document.annotations,
    status: document.status,
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function toFailure(error: unknown): AppFailure {
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return new AppFailure({
      code: "permission",
      message: "The plan document cannot be read.",
      retryable: false,
    });
  }
  return new AppFailure(
    { code: "internal", message: "Unable to read the plan document.", retryable: false },
    { cause: error },
  );
}
function reportObserverError(callback: PlanDocumentStoreOptions["onError"], error: unknown): void {
  if (callback === undefined) return;
  const failure =
    error instanceof AppFailure
      ? error
      : new AppFailure(
          { code: "internal", message: "A plan change observer failed.", retryable: false },
          { cause: error },
        );
  try {
    callback(failure);
  } catch (callbackError) {
    // An observer's error callback cannot invalidate a committed document.
    void callbackError;
  }
}

function invalidArgs(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

function conflictFailure(): AppFailure {
  return new AppFailure({
    code: "conflict",
    message: "The plan changed; reload before saving.",
    retryable: true,
  });
}

function notFoundFailure(): AppFailure {
  return new AppFailure({
    code: "not_found",
    message: "The plan document was not found.",
    retryable: false,
  });
}

function timeoutFailure(): AppFailure {
  return new AppFailure({
    code: "timeout",
    message: "The plan document search timed out.",
    retryable: true,
  });
}
