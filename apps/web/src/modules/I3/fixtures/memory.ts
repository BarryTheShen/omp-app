import { type MemoryEntry, MemoryListResult, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import type { MemoryCommandResult } from "../memory/commands";

const RECORDED_AT = "2026-10-20T12:00:00.000Z";

/** Synthetic, scrubbed A1.14 values: no backend paths, credentials or user text. */
export const I3_MEMORY_ENTRIES = [
  {
    id: "0123456789abcdef",
    scope: "global",
    folder: null,
    threadId: null,
    namespace: "preference",
    content: "Prefer concise implementation notes.",
    metadata: { source: "fixture", sensitive: false },
    createdAt: RECORDED_AT,
    updatedAt: RECORDED_AT,
    sensitive: false,
    provenance: { source: "backend", scope: "global" },
  },
  {
    id: "fedcba9876543210",
    scope: "project",
    folder: null,
    threadId: null,
    namespace: "project-note",
    content: "Use the project's existing test conventions.",
    metadata: { source: "fixture", redacted: true },
    createdAt: RECORDED_AT,
    updatedAt: RECORDED_AT,
    sensitive: true,
    provenance: { source: "omp-memory", scope: "project" },
  },
  {
    id: "0011223344556677",
    scope: "session",
    folder: null,
    threadId: ThreadIdSchema.parse("fixture-thread"),
    namespace: "session-note",
    content: "The pending draft must survive a failed write.",
    metadata: { source: "fixture" },
    createdAt: RECORDED_AT,
    updatedAt: RECORDED_AT,
    sensitive: false,
    provenance: { source: "command", scope: "session" },
  },
] as const satisfies readonly MemoryEntry[];

export const I3_MEMORY_PAGE = MemoryListResult.parse({
  parsed: true,
  rawText: "",
  entries: I3_MEMORY_ENTRIES,
  nextCursor: "page-2",
  revision: "memory-revision-1",
});

// Exact strings are from omp v18.8.9 packages/coding-agent/src/slash-commands/builtin-lifecycle.ts:568-607.
export const I3_MEMORY_COMMAND_RESULTS = [
  { command: "view", status: "complete", message: "Memory payload is empty." },
  { command: "clear", status: "complete", message: "Memory cleared." },
  { command: "reset", status: "complete", message: "Memory cleared." },
  { command: "enqueue", status: "pending", message: "Memory consolidation enqueued." },
  { command: "rebuild", status: "pending", message: "Memory consolidation enqueued." },
] as const satisfies readonly MemoryCommandResult[];
