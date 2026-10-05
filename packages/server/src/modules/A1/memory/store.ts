import {
  AppFailure,
  type CapabilityKey,
  type FolderPath,
  MemoryChanged,
  type MemoryChanged as MemoryChangedValue,
  MemoryClearArgs,
  type MemoryClearArgs as MemoryClearArgsValue,
  MemoryClearResult,
  type MemoryClearResult as MemoryClearResultValue,
  MemoryDeleteArgs,
  type MemoryDeleteArgs as MemoryDeleteArgsValue,
  MemoryDeleteResult,
  type MemoryDeleteResult as MemoryDeleteResultValue,
  MemoryEntry,
  type MemoryEntry as MemoryEntryValue,
  MemoryGetArgs,
  type MemoryGetArgs as MemoryGetArgsValue,
  MemoryGetResult,
  type MemoryGetResult as MemoryGetResultValue,
  MemoryId,
  MemoryListArgs,
  type MemoryListArgs as MemoryListArgsValue,
  MemoryListResult,
  type MemoryListResult as MemoryListResultValue,
  MemoryWriteArgs,
  type MemoryWriteArgs as MemoryWriteArgsValue,
  type MemoryWriteResult as MemoryWriteResultValue,
} from "@omp-app/contracts";
import type { z } from "zod";
import { hashContent } from "../fs";

const CAPABILITY = "host.memory-store" as const;
const EDIT_CAPABILITY = "upstream.memory-edit" as const;
const GATEWAY_CAPABILITY = "host.command-gateway" as const;
const EDIT_UNAVAILABLE_REASON =
  "omp v18.6.1 has no typed memory-edit command; editing one memory is unavailable rather than emulated.";
const GATEWAY_UNAVAILABLE_REASON = "The memory command gateway is unavailable.";

export interface MemoryCommandGateway {
  readonly run: (args: {
    readonly threadId: string;
    readonly command: string;
  }) => Promise<{ readonly outputs: readonly { readonly text: string }[] }>;
}

export interface MemoryStoreOptions {
  readonly gateway?: MemoryCommandGateway;
  readonly threadId?: string;
  readonly onError?: (error: AppFailure) => void;
}

export type MemoryChangedListener = (change: MemoryChangedValue) => void;

function unavailable(message: string, capability: CapabilityKey = CAPABILITY): AppFailure {
  return new AppFailure({ code: "unavailable", message, retryable: false, capability });
}

function invalidArgs(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

function internalFailure(message: string, cause?: unknown): AppFailure {
  return new AppFailure(
    { code: "internal", message, retryable: false },
    cause === undefined ? undefined : { cause },
  );
}

function asFailure(error: unknown, message: string): AppFailure {
  return error instanceof AppFailure ? error : internalFailure(message, error);
}

function parseArgs<Output>(schema: z.ZodType<Output>, value: unknown, message: string): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidArgs(message);
  return parsed.data;
}

function rawText(result: { readonly outputs: readonly { readonly text: string }[] }): string {
  return result.outputs
    .map((output) => output.text)
    .join("\n")
    .trim();
}

function revisionFor(raw: string): string {
  return hashContent(raw || "<empty-memory-result>");
}

function timestamp(): string {
  return new Date().toISOString();
}

function makeEntry(
  args: {
    readonly folder: FolderPath | null;
    readonly scope: MemoryListArgsValue["scope"];
    readonly threadId?: MemoryListArgsValue["threadId"];
  },
  id: string,
  content: string,
): MemoryEntryValue {
  const now = timestamp();
  return {
    id,
    scope: args.scope,
    folder: args.folder,
    threadId: args.threadId ?? null,
    namespace: "memory",
    content,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    sensitive: false,
    provenance: { source: "command", scope: args.scope },
  };
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function parseListText(raw: string, args: MemoryListArgsValue): MemoryListResultValue {
  const parsed = parseJsonObject(raw);
  if (parsed) {
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.flatMap((value) => {
          const entry = MemoryEntry.safeParse(value);
          return entry.success ? [entry.data] : [];
        })
      : [];
    if (entries.length > 0 || parsed.entries !== undefined) {
      return {
        parsed: entries.length > 0 || Array.isArray(parsed.entries),
        rawText: raw,
        entries,
        nextCursor: typeof parsed.nextCursor === "string" ? parsed.nextCursor : null,
        revision: revisionFor(raw),
      };
    }
  }
  const entries: MemoryEntryValue[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    const table = /^\s*\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    const candidate =
      bullet?.[1] ??
      (table?.[1] && table[2] && !/^[-\s|]+$/.test(table[1])
        ? `${table[1]}: ${table[2]}`
        : undefined);
    if (!candidate) continue;
    const match = /^([^:\s]+)\s*:\s*(.+)$/.exec(candidate);
    const id = match?.[1];
    const content = match?.[2];
    const safeId = MemoryId.safeParse(id);
    if (!safeId.success || !content) continue;
    entries.push(makeEntry(args, safeId.data, content));
  }
  return {
    parsed: entries.length > 0,
    rawText: raw,
    entries,
    nextCursor: null,
    revision: revisionFor(raw),
  };
}

function parseGetText(raw: string, args: MemoryGetArgsValue): MemoryGetResultValue {
  const parsed = parseJsonObject(raw);
  if (parsed && typeof parsed.content === "string") {
    return { parsed: true, rawText: raw, entry: makeEntry(args, args.id, parsed.content) };
  }
  const body = raw.replace(/^\s*#+\s*[^\n]*\n?/, "").trim();
  if (body.length > 0 && !/^memory (?:not found|error)/i.test(body)) {
    return { parsed: true, rawText: raw, entry: makeEntry(args, args.id, body) };
  }
  return { parsed: false, rawText: raw, entry: null };
}

function parseDeleteText(raw: string): MemoryDeleteResultValue {
  return { parsed: /(?:deleted|removed)/i.test(raw), rawText: raw, revision: revisionFor(raw) };
}

function parseClearText(raw: string): MemoryClearResultValue {
  const count = /(?:deleted|cleared)\D+(\d+)/i.exec(raw)?.[1];
  return {
    parsed: /(?:cleared|reset|deleted)/i.test(raw),
    rawText: raw,
    revision: revisionFor(raw),
    deletedCount: count === undefined ? 0 : Number.parseInt(count, 10),
  };
}

/**
 * A1 memory seam over A1.8's structured command gateway. omp's v18.6.1 slash handler renders the
 * `/memory` family in `packages/coding-agent/src/slash-commands/builtin-lifecycle.ts:397-468`;
 * backend status/fallback text is defined by `packages/coding-agent/src/memory-backend/messages.ts`.
 * Parsers are intentionally conservative: a format mismatch returns raw text with `parsed:false`.
 */
export class MemoryStoreService {
  readonly #gateway: MemoryCommandGateway | undefined;
  readonly #threadId: string | undefined;
  readonly #onError: MemoryStoreOptions["onError"];
  readonly #listeners = new Set<MemoryChangedListener>();

  constructor(options: MemoryStoreOptions = {}) {
    this.#gateway = options.gateway;
    this.#threadId = options.threadId;
    this.#onError = options.onError;
  }

  async list(args: MemoryListArgsValue): Promise<MemoryListResultValue> {
    const parsed = parseArgs(MemoryListArgs, args, "Invalid memory list arguments.");
    const result = await this.runCommand("/memory mm list");
    return MemoryListResult.parse(parseListText(result, parsed));
  }

  async get(args: MemoryGetArgsValue): Promise<MemoryGetResultValue> {
    const parsed = parseArgs(MemoryGetArgs, args, "Invalid memory get arguments.");
    const result = await this.runCommand(`/memory mm show ${parsed.id}`);
    return MemoryGetResult.parse(parseGetText(result, parsed));
  }

  async write(_args: MemoryWriteArgsValue): Promise<MemoryWriteResultValue> {
    parseArgs(MemoryWriteArgs, _args, "Invalid memory write arguments.");
    throw unavailable(EDIT_UNAVAILABLE_REASON, EDIT_CAPABILITY);
  }

  async delete(args: MemoryDeleteArgsValue): Promise<MemoryDeleteResultValue> {
    const parsed = parseArgs(MemoryDeleteArgs, args, "Invalid memory delete arguments.");
    if (!parsed.confirmed) throw invalidArgs("Deleting a memory requires explicit confirmation.");
    const result = await this.runCommand(`/memory mm delete ${parsed.id}`);
    const output = parseDeleteText(result);
    if (output.parsed && output.revision) {
      this.publishChange(parsed, output.revision, [parsed.id], "command");
    }
    return MemoryDeleteResult.parse(output);
  }

  async clear(args: MemoryClearArgsValue): Promise<MemoryClearResultValue> {
    const parsed = parseArgs(MemoryClearArgs, args, "Invalid memory clear arguments.");
    if (!parsed.confirmed) throw invalidArgs("Clearing memory requires explicit confirmation.");
    const result = await this.runCommand(`/memory ${parsed.operation}`);
    const output = parseClearText(result);
    if (output.parsed && output.revision) {
      this.publishChange(parsed, output.revision, [], "command");
    }
    return MemoryClearResult.parse(output);
  }

  subscribe(listener: MemoryChangedListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#listeners.clear();
  }

  private async runCommand(command: string): Promise<string> {
    if (!this.#gateway || !this.#threadId) {
      throw unavailable(GATEWAY_UNAVAILABLE_REASON, GATEWAY_CAPABILITY);
    }
    try {
      const result = await this.#gateway.run({ threadId: this.#threadId, command });
      return rawText(result);
    } catch (error) {
      throw asFailure(error, "Memory command failed.");
    }
  }

  private publishChange(
    args: { readonly folder: FolderPath | null; readonly scope: MemoryListArgsValue["scope"] },
    revision: string,
    ids: string[],
    reason: MemoryChangedValue["reason"],
  ): void {
    const change: MemoryChangedValue = MemoryChanged.parse({
      folder: args.folder,
      scope: args.scope,
      revision,
      ids,
      reason,
    });
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch (error) {
        this.report(error, "Memory changed listener failed.");
      }
    }
  }

  private report(error: unknown, message: string): void {
    if (!this.#onError) return;
    try {
      this.#onError(asFailure(error, message));
    } catch {
      // Error observers must not break memory command delivery.
    }
  }
}

export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStoreService {
  return new MemoryStoreService(options);
}
