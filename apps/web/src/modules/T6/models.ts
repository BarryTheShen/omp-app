import type { CapabilityKey, CapabilityMap } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { z } from "zod";
import { OutputMetaSchema } from "../U3/tool-card/output-meta";

const MAX_MEMORY_TEXT = 4_000;

export const T6_CAPABILITIES = {
  memoryEdit: "upstream.memory-edit" as CapabilityKey,
} as const;

export const MemoryRecallArgsSchema = z.looseObject({ query: z.string().optional() });
export const MemoryReflectArgsSchema = z.looseObject({
  query: z.string().optional(),
  context: z.string().optional(),
});
export const MemoryRetainArgsSchema = z.looseObject({
  items: z
    .array(
      z.looseObject({
        content: z.string().optional(),
        context: z.string().optional(),
        scope: z.enum(["project", "global"]).optional(),
      }),
    )
    .optional(),
});
export const LearnArgsSchema = z.looseObject({
  memory: z.string().optional(),
  context: z.string().optional(),
  scope: z.enum(["project", "global"]).optional(),
  skill: z
    .looseObject({
      action: z.enum(["create", "update"]).optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      body: z.string().optional(),
    })
    .optional(),
});
export const ManageSkillArgsSchema = z.looseObject({
  action: z.enum(["create", "update", "delete"]).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  body: z.string().optional(),
});
export const MemoryEditArgsSchema = z.looseObject({
  op: z.enum(["update", "forget", "invalidate"]).optional(),
  id: z.string().optional(),
  content: z.string().optional(),
  importance: z.number().optional(),
  replacement_id: z.string().optional(),
});

export type MemoryRecallArgs = z.infer<typeof MemoryRecallArgsSchema>;
export type MemoryReflectArgs = z.infer<typeof MemoryReflectArgsSchema>;
export type MemoryRetainArgs = z.infer<typeof MemoryRetainArgsSchema>;
export type LearnArgs = z.infer<typeof LearnArgsSchema>;
export type ManageSkillArgs = z.infer<typeof ManageSkillArgsSchema>;
export type MemoryEditArgs = z.infer<typeof MemoryEditArgsSchema>;

export const RecallDetailsSchema = z.looseObject({
  count: z.int().nonnegative().optional(),
  noMatch: z.boolean().optional(),
  meta: OutputMetaSchema.optional(),
});
export const ReflectDetailsSchema = z.looseObject({ meta: OutputMetaSchema.optional() });
export const RetainDetailsSchema = z.looseObject({
  count: z.int().nonnegative().optional(),
  stored: z.int().nonnegative().optional(),
  queued: z.int().nonnegative().optional(),
  failed: z.array(z.unknown()).optional(),
  meta: OutputMetaSchema.optional(),
});
export const LearnDetailsSchema = z.looseObject({
  skill: z.string().nullable().optional(),
  shadowed: z.boolean().optional(),
  meta: OutputMetaSchema.optional(),
});
export const ManageSkillDetailsSchema = z.looseObject({
  action: z.enum(["create", "update", "delete"]).optional(),
  name: z.string().optional(),
  shadowed: z.boolean().optional(),
  meta: OutputMetaSchema.optional(),
});
export const MemoryEditDetailsSchema = z.looseObject({
  status: z.string().optional(),
  id: z.string().optional(),
  bank: z.string().optional(),
  store: z.string().optional(),
  meta: OutputMetaSchema.optional(),
});

export type RecallDetails = z.infer<typeof RecallDetailsSchema>;
export type ReflectDetails = z.infer<typeof ReflectDetailsSchema>;
export type RetainDetails = z.infer<typeof RetainDetailsSchema>;
export type LearnDetails = z.infer<typeof LearnDetailsSchema>;
export type ManageSkillDetails = z.infer<typeof ManageSkillDetailsSchema>;
export type MemoryEditDetails = z.infer<typeof MemoryEditDetailsSchema>;

export interface T6Decode<T> {
  readonly ok: boolean;
  readonly value: T | undefined;
  readonly raw: unknown;
  readonly error?: AppFailure;
}

export interface MemoryText {
  readonly text: string;
  readonly truncated: boolean;
}

export interface RecallModel {
  readonly query: string;
  readonly count: number | null;
  readonly noMatch: boolean;
  readonly content: MemoryText;
  readonly raw: unknown;
  readonly details: RecallDetails | undefined;
  readonly malformed: boolean;
}
export interface ReflectModel {
  readonly query: string;
  readonly context: string | undefined;
  readonly answer: MemoryText;
  readonly noInformation: boolean;
  readonly raw: unknown;
  readonly details: ReflectDetails | undefined;
  readonly malformed: boolean;
}
export interface RetainModel {
  readonly items: readonly {
    readonly content: string;
    readonly context?: string;
    readonly scope?: "project" | "global";
  }[];
  readonly count: number | null;
  readonly status: "stored" | "queued" | "partial" | "unknown";
  readonly details: RetainDetails | undefined;
  readonly raw: unknown;
  readonly malformed: boolean;
}
export interface LearnModel {
  readonly memory: string;
  readonly scope: "project" | "global" | undefined;
  readonly skill: { readonly action?: "create" | "update"; readonly name?: string } | undefined;
  readonly skillStatus: "stored" | "queued" | "created" | "updated" | "shadowed" | "unknown";
  readonly raw: unknown;
  readonly details: LearnDetails | undefined;
  readonly malformed: boolean;
}
export interface ManageSkillModel {
  readonly action: "create" | "update" | "delete" | "unknown";
  readonly name: string;
  readonly status: "created" | "updated" | "deleted" | "shadowed" | "unknown";
  readonly raw: unknown;
  readonly details: ManageSkillDetails | undefined;
  readonly malformed: boolean;
}
export interface MemoryEditModel {
  readonly operation: "update" | "forget" | "invalidate" | "unknown";
  readonly id: string;
  readonly status: string;
  readonly raw: unknown;
  readonly details: MemoryEditDetails | undefined;
  readonly malformed: boolean;
}

function decode<T>(schema: z.ZodType<T>, raw: unknown, label: string): T6Decode<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data, raw };
  return {
    ok: false,
    value: undefined,
    raw,
    error: new AppFailure({
      code: "invalid_args",
      message: `Malformed ${label}; showing the raw memory result.`,
      retryable: false,
    }),
  };
}

function bounded(value: unknown): MemoryText {
  const text = typeof value === "string" ? value : value === undefined ? "" : safeJson(value);
  return text.length <= MAX_MEMORY_TEXT
    ? { text, truncated: false }
    : { text: `${text.slice(0, MAX_MEMORY_TEXT)}…`, truncated: true };
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : "[unavailable]";
  } catch {
    return "[unavailable]";
  }
}

function contentText(raw: unknown): string {
  if (!Array.isArray(raw)) return typeof raw === "string" ? raw : "";
  return raw
    .map((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .join("");
}

export function decodeMemoryRecallArgs(raw: unknown): T6Decode<MemoryRecallArgs> {
  return decode(MemoryRecallArgsSchema, raw, "recall arguments");
}
export function decodeMemoryReflectArgs(raw: unknown): T6Decode<MemoryReflectArgs> {
  return decode(MemoryReflectArgsSchema, raw, "reflect arguments");
}
export function decodeMemoryRetainArgs(raw: unknown): T6Decode<MemoryRetainArgs> {
  return decode(MemoryRetainArgsSchema, raw, "retain arguments");
}
export function decodeLearnArgs(raw: unknown): T6Decode<LearnArgs> {
  return decode(LearnArgsSchema, raw, "learn arguments");
}
export function decodeManageSkillArgs(raw: unknown): T6Decode<ManageSkillArgs> {
  return decode(ManageSkillArgsSchema, raw, "manage_skill arguments");
}
export function decodeMemoryEditArgs(raw: unknown): T6Decode<MemoryEditArgs> {
  return decode(MemoryEditArgsSchema, raw, "memory_edit arguments");
}

export function normalizeRecall(args: unknown, result: unknown): RecallModel {
  const decoded = decodeMemoryRecallArgs(args);
  const record = result && typeof result === "object" ? result : {};
  const content = bounded(record && "content" in record ? contentText(record.content) : result);
  const details = decode(
    RecallDetailsSchema,
    record && "details" in record ? record.details : undefined,
    "recall details",
  );
  return {
    query: decoded.value?.query ?? "",
    count:
      details.value?.count ??
      (details.value?.noMatch || content.text.includes("No relevant memories") ? 0 : null),
    noMatch: details.value?.noMatch === true || content.text.includes("No relevant memories found"),
    content,
    raw: result,
    details: details.value,
    malformed: !decoded.ok || !details.ok,
  };
}

export function normalizeReflect(args: unknown, result: unknown): ReflectModel {
  const decoded = decodeMemoryReflectArgs(args);
  const record = result && typeof result === "object" ? result : {};
  const content = bounded(record && "content" in record ? contentText(record.content) : result);
  const details = decode(
    ReflectDetailsSchema,
    record && "details" in record ? record.details : undefined,
    "reflect details",
  );
  return {
    query: decoded.value?.query ?? "",
    context: decoded.value?.context,
    answer: content,
    noInformation: content.text.includes("No relevant information found"),
    raw: result,
    details: details.value,
    malformed: !decoded.ok || !details.ok,
  };
}

/** The model often passes `items` as JSON text; the list it names is the same either way. */
function parsedRetainItems(args: unknown): unknown {
  const text = z.looseObject({ items: z.string() }).safeParse(args);
  if (!text.success) return args;
  try {
    return { ...text.data, items: JSON.parse(text.data.items) };
  } catch {
    return args;
  }
}

export function normalizeRetain(args: unknown, result: unknown): RetainModel {
  const decoded = decodeMemoryRetainArgs(parsedRetainItems(args));
  const record = result && typeof result === "object" ? result : {};
  const details = decode(
    RetainDetailsSchema,
    record && "details" in record ? record.details : undefined,
    "retain details",
  );
  const items =
    decoded.value?.items
      ?.filter(
        (item): item is typeof item & { content: string } => typeof item.content === "string",
      )
      .map((item) => ({ content: item.content, context: item.context, scope: item.scope })) ?? [];
  const count = details.value?.count ?? details.value?.stored ?? details.value?.queued ?? null;
  const status =
    details.value?.failed && details.value.failed.length > 0
      ? "partial"
      : details.value?.queued
        ? "queued"
        : details.value?.stored
          ? "stored"
          : "unknown";
  return {
    items,
    count,
    status,
    details: details.value,
    raw: result,
    malformed: !decoded.ok || !details.ok,
  };
}

export function normalizeLearn(args: unknown, result: unknown): LearnModel {
  const decoded = decodeLearnArgs(args);
  const record = result && typeof result === "object" ? result : {};
  const details = decode(
    LearnDetailsSchema,
    record && "details" in record ? record.details : undefined,
    "learn details",
  );
  const skill = decoded.value?.skill;
  const text = contentText(record && "content" in record ? record.content : result);
  const skillStatus = details.value?.shadowed
    ? "shadowed"
    : details.value?.skill
      ? text.includes("Updated")
        ? "updated"
        : "created"
      : text.includes("queued")
        ? "queued"
        : text.includes("stored")
          ? "stored"
          : "unknown";
  return {
    memory: decoded.value?.memory ?? "",
    scope: decoded.value?.scope,
    skill: skill ? { action: skill.action, name: skill.name } : undefined,
    skillStatus,
    raw: result,
    details: details.value,
    malformed: !decoded.ok || !details.ok,
  };
}

export function normalizeManageSkill(args: unknown, result: unknown): ManageSkillModel {
  const decoded = decodeManageSkillArgs(args);
  const record = result && typeof result === "object" ? result : {};
  const details = decode(
    ManageSkillDetailsSchema,
    record && "details" in record ? record.details : undefined,
    "manage_skill details",
  );
  const action = decoded.value?.action ?? details.value?.action ?? "unknown";
  const text = contentText(record && "content" in record ? record.content : result);
  const status = details.value?.shadowed
    ? "shadowed"
    : action === "create" && text.includes("Created")
      ? "created"
      : action === "update" && text.includes("Updated")
        ? "updated"
        : action === "delete" && text.includes("Deleted")
          ? "deleted"
          : "unknown";
  return {
    action,
    name: decoded.value?.name ?? details.value?.name ?? "",
    status,
    raw: result,
    details: details.value,
    malformed: !decoded.ok || !details.ok,
  };
}

export function normalizeMemoryEdit(args: unknown, result: unknown): MemoryEditModel {
  const decoded = decodeMemoryEditArgs(args);
  const record = result && typeof result === "object" ? result : {};
  const details = decode(
    MemoryEditDetailsSchema,
    record && "details" in record ? record.details : undefined,
    "memory_edit details",
  );
  return {
    operation: decoded.value?.op ?? "unknown",
    id: decoded.value?.id ?? details.value?.id ?? "",
    status:
      details.value?.status ?? contentText(record && "content" in record ? record.content : result),
    raw: result,
    details: details.value,
    malformed: !decoded.ok || !details.ok,
  };
}

export function mapT6Failure(error: unknown, toolName: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    {
      code: "internal",
      message: `${toolName} failed; memory details were not retained in the error`,
      retryable: true,
    },
    { cause: error },
  );
}

export function capabilityAvailable(
  capabilities: CapabilityMap,
  capability: CapabilityKey,
): boolean {
  return capabilities[capability]?.state === "available";
}

export function capabilityFailure(capability: CapabilityKey, message: string): AppFailure {
  return new AppFailure({ code: "unavailable", message, retryable: false, capability });
}

export type T6ToolArgs =
  | MemoryRecallArgs
  | MemoryReflectArgs
  | MemoryRetainArgs
  | LearnArgs
  | ManageSkillArgs
  | MemoryEditArgs;

export type T6ToolDetails =
  | RecallDetails
  | ReflectDetails
  | RetainDetails
  | LearnDetails
  | ManageSkillDetails
  | MemoryEditDetails;
