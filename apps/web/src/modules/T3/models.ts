import type { CapabilityKey, CapabilityMap } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { z } from "zod";
import { type OutputMeta, OutputMetaSchema } from "../U3/tool-card/output-meta";

const UnknownRecord = z.record(z.string(), z.unknown());
const MAX_PREVIEW = 4_000;

export const T3_CAPABILITIES = {
  eval: "upstream.eval" as CapabilityKey,
  debug: "upstream.debug" as CapabilityKey,
  computer: "upstream.computer" as CapabilityKey,
  inspectImage: "upstream.inspect-image" as CapabilityKey,
} as const;

export const EvalArgsSchema = z.looseObject({
  language: z.enum(["py", "js"]).nullish(),
  code: z.string().nullish(),
  title: z.string().nullish(),
  timeout: z.number().nonnegative().nullish(),
  reset: z.boolean().nullish(),
});
/** omp v18.6.1 `debug` parameters (packages/coding-agent/src/tools/debug.ts:69-138). */
export const DebugArgsSchema = z.looseObject({
  action: z.string().optional(),
  program: z.string().optional(),
  args: z.array(z.string()).optional(),
  adapter: z.string().optional(),
  cwd: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  function: z.string().optional(),
  name: z.string().optional(),
  condition: z.string().optional(),
  expression: z.string().optional(),
  pid: z.number().int().nonnegative().optional(),
  port: z.number().int().nonnegative().optional(),
  memory_reference: z.string().optional(),
  instruction_reference: z.string().optional(),
  data_id: z.string().optional(),
  command: z.string().optional(),
  timeout: z.number().nonnegative().optional(),
});
export const ComputerArgsSchema = z.looseObject({
  action: z.enum(["run", "call", "capabilities", "close"]).optional(),
  code: z.string().optional(),
  fn: z.string().optional(),
  args: z.array(z.unknown()).optional(),
  read_only: z.boolean().optional(),
  timeout: z.number().nonnegative().optional(),
  chain: z.array(UnknownRecord).optional(),
});
export const InspectImageArgsSchema = z.looseObject({
  path: z.string().optional(),
  mode: z.string().optional(),
  prompt: z.string().optional(),
});

export type EvalArgs = z.infer<typeof EvalArgsSchema>;
export type DebugArgs = z.infer<typeof DebugArgsSchema>;
export type ComputerArgs = z.infer<typeof ComputerArgsSchema>;
export type InspectImageArgs = z.infer<typeof InspectImageArgsSchema>;

export const EvalCellSchema = z.looseObject({
  index: z.int().nonnegative().optional(),
  title: z.string().optional(),
  code: z.string().optional(),
  language: z.string().optional(),
  output: z.unknown().optional(),
  status: z.enum(["pending", "running", "complete", "error"]).optional(),
  durationMs: z.number().nonnegative().optional(),
  exitCode: z.number().int().optional(),
  statusEvents: z.array(z.unknown()).optional(),
  hasMarkdown: z.boolean().optional(),
});
export const EvalDetailsSchema = z.looseObject({
  cells: z.array(EvalCellSchema).optional(),
  jsonOutputs: z.array(z.unknown()).optional(),
  images: z.array(z.unknown()).optional(),
  statusEvents: z.array(z.unknown()).optional(),
  isError: z.boolean().optional(),
  meta: OutputMetaSchema.optional(),
  language: z.string().optional(),
  languages: z.array(z.string()).optional(),
  notice: z.string().optional(),
  async: z
    .looseObject({
      state: z.enum(["running", "completed", "failed"]).optional(),
      jobId: z.string().optional(),
      type: z.string().optional(),
    })
    .optional(),
});
/** omp v18.6.1 DAP shapes (packages/coding-agent/src/dap/types.ts:4,42-49,233-244,279-294,382-400,515-521,543-549,564-590). */
const DapSourceSchema = z.looseObject({
  name: z.string().optional(),
  path: z.string().optional(),
});
const DebugSessionSnapshotSchema = z.looseObject({
  id: z.string().optional(),
  adapter: z.string().optional(),
  cwd: z.string().optional(),
  program: z.string().optional(),
  status: z.string().optional(),
  stopReason: z.string().optional(),
  stopDescription: z.string().optional(),
  frameName: z.string().optional(),
  source: DapSourceSchema.optional(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  exitCode: z.number().int().optional(),
  needsConfigurationDone: z.boolean().optional(),
});
const DebugStackFrameSchema = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  source: DapSourceSchema.optional(),
  line: z.number().int(),
  column: z.number().int().optional(),
});
const DebugThreadSchema = z.looseObject({ id: z.number().int(), name: z.string() });
const DebugVariableSchema = z.looseObject({
  name: z.string(),
  value: z.string(),
  type: z.string().optional(),
});
const DebugBreakpointSchema = z.looseObject({
  verified: z.boolean(),
  line: z.number().int().optional(),
  name: z.string().optional(),
  condition: z.string().optional(),
  message: z.string().optional(),
});

/**
 * omp v18.6.1 `DebugExecutionDetails` (packages/coding-agent/src/tools/debug.ts:143-171; base
 * `DebugToolDetails` in packages/tui/src/tools/debug.ts:38-42). Each action fills only its own
 * fields; the result's text content repeats them for the model.
 */
export const DebugDetailsSchema = z.looseObject({
  action: z.string().optional(),
  success: z.boolean().optional(),
  snapshot: DebugSessionSnapshotSchema.optional(),
  sessions: z.array(DebugSessionSnapshotSchema).optional(),
  stackFrames: z.array(DebugStackFrameSchema).optional(),
  threads: z.array(DebugThreadSchema).optional(),
  scopes: z.array(UnknownRecord).optional(),
  variables: z.array(DebugVariableSchema).optional(),
  sources: z.array(DapSourceSchema).optional(),
  modules: z.array(UnknownRecord).optional(),
  evaluation: z.looseObject({ result: z.string(), type: z.string().optional() }).optional(),
  breakpoints: z.array(DebugBreakpointSchema).optional(),
  functionBreakpoints: z.array(DebugBreakpointSchema).optional(),
  output: z.string().optional(),
  adapter: z.string().optional(),
  state: z.enum(["running", "stopped", "terminated"]).optional(),
  timedOut: z.boolean().optional(),
  meta: OutputMetaSchema.optional(),
});
export const ComputerDetailsSchema = z.looseObject({
  action: z.string().optional(),
  code: z.string().optional(),
  readOnly: z.boolean().optional(),
  screenshots: z.array(z.unknown()).optional(),
  value: z.unknown().optional(),
  backend: z.string().optional(),
  permissions: UnknownRecord.optional(),
  output: z.unknown().optional(),
  meta: OutputMetaSchema.optional(),
});
export const InspectImageDetailsSchema = z.looseObject({
  path: z.string().optional(),
  mode: z.string().optional(),
  status: z.string().optional(),
  description: z.string().optional(),
  analysis: z.string().optional(),
  image: z.unknown().optional(),
  error: z.string().optional(),
  meta: OutputMetaSchema.optional(),
});

export type EvalCell = z.infer<typeof EvalCellSchema>;
export type EvalDetails = z.infer<typeof EvalDetailsSchema>;
export type DebugDetails = z.infer<typeof DebugDetailsSchema>;
export type ComputerDetails = z.infer<typeof ComputerDetailsSchema>;
export type InspectImageDetails = z.infer<typeof InspectImageDetailsSchema>;

export interface T3Decode<T> {
  readonly ok: boolean;
  readonly value: T | undefined;
  readonly raw: unknown;
  readonly error?: AppFailure;
}

export interface T3ToolModel<TArgs, TDetails> {
  readonly args: TArgs | undefined;
  readonly details: TDetails | undefined;
  readonly raw: unknown;
  readonly malformed: boolean;
  readonly preview: string;
  readonly outputMeta?: OutputMeta;
}

function decode<T>(schema: z.ZodType<T>, raw: unknown, label: string): T3Decode<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data, raw };
  return {
    ok: false,
    value: undefined,
    raw,
    error: new AppFailure({
      code: "invalid_args",
      message: `Malformed ${label}; showing the raw execution result.`,
      retryable: false,
    }),
  };
}

function bounded(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = "[unavailable]";
    }
  }
  return text.length <= MAX_PREVIEW ? text : `${text.slice(0, MAX_PREVIEW)}…`;
}

function contentText(raw: unknown): string {
  if (!Array.isArray(raw)) return typeof raw === "string" ? raw : bounded(raw);
  return raw
    .map((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof part.text === "string"
      )
        return part.text;
      return "";
    })
    .join("");
}
export function decodeEvalArgs(raw: unknown): T3Decode<EvalArgs> {
  return decode(EvalArgsSchema, raw, "eval arguments");
}
export function decodeDebugArgs(raw: unknown): T3Decode<DebugArgs> {
  return decode(DebugArgsSchema, raw, "debug arguments");
}
export function decodeDebugDetails(raw: unknown): T3Decode<DebugDetails> {
  return decode(DebugDetailsSchema, raw, "debug details");
}
export function decodeComputerArgs(raw: unknown): T3Decode<ComputerArgs> {
  return decode(ComputerArgsSchema, raw, "computer arguments");
}
export function decodeInspectImageArgs(raw: unknown): T3Decode<InspectImageArgs> {
  return decode(InspectImageArgsSchema, raw, "inspect_image arguments");
}

function model<TArgs, TDetails>(
  argsSchema: z.ZodType<TArgs>,
  detailsSchema: z.ZodType<TDetails>,
  args: unknown,
  result: unknown,
  label: string,
): T3ToolModel<TArgs, TDetails> {
  const decodedArgs = decode(argsSchema, args, `${label} arguments`);
  const record = result && typeof result === "object" ? result : {};
  const detailsRaw = record && "details" in record ? record.details : undefined;
  const decodedDetails = decode(detailsSchema, detailsRaw, `${label} details`);
  const output = record && "content" in record ? contentText(record.content) : result;
  const detailsRecord =
    typeof decodedDetails.value === "object" && decodedDetails.value !== null
      ? (decodedDetails.value as Record<string, unknown>)
      : undefined;
  const outputMetaParsed =
    detailsRecord && "meta" in detailsRecord
      ? OutputMetaSchema.safeParse(detailsRecord.meta)
      : undefined;
  const outputMeta = outputMetaParsed?.success ? outputMetaParsed.data : undefined;
  return {
    args: decodedArgs.value,
    details: decodedDetails.value,
    raw: result,
    malformed: !decodedArgs.ok || !decodedDetails.ok,
    preview: bounded(output),
    outputMeta,
  };
}

export function normalizeEval(args: unknown, result: unknown): T3ToolModel<EvalArgs, EvalDetails> {
  return model(EvalArgsSchema, EvalDetailsSchema, args, result, "eval");
}
export function normalizeComputer(
  args: unknown,
  result: unknown,
): T3ToolModel<ComputerArgs, ComputerDetails> {
  return model(ComputerArgsSchema, ComputerDetailsSchema, args, result, "computer");
}
export function normalizeInspectImage(
  args: unknown,
  result: unknown,
): T3ToolModel<InspectImageArgs, InspectImageDetails> {
  return model(InspectImageArgsSchema, InspectImageDetailsSchema, args, result, "inspect_image");
}

export function mapT3Failure(error: unknown, toolName: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    {
      code: "internal",
      message: `${toolName} failed; execution details were not retained in the error`,
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

export type T3ToolArgs = EvalArgs | DebugArgs | ComputerArgs | InspectImageArgs;
export type T3ToolDetails = EvalDetails | DebugDetails | ComputerDetails | InspectImageDetails;
