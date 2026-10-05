import type { RuntimeMessage } from "../../R0/store/store";

export type ExecutionMode = "bash" | "python";

export interface ExecutionRecord {
  readonly id: string;
  readonly mode: ExecutionMode;
  readonly source: string;
  readonly output: string;
  readonly cancelled: boolean;
  readonly truncated: boolean;
  readonly exitCode?: number;
  readonly images?: readonly unknown[];
  readonly excludeFromContext: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}

/** Converts R0.1's normalized execution message without parsing wire frames or creating state. */
export function normalizeExecutionMessage(message: RuntimeMessage): ExecutionRecord | undefined {
  const raw = message.message;
  if (!isRecord(raw) || (raw.role !== "bashExecution" && raw.role !== "pythonExecution"))
    return undefined;
  const mode: ExecutionMode = raw.role === "bashExecution" ? "bash" : "python";
  const source = mode === "bash" ? stringField(raw, "command") : stringField(raw, "code");
  return {
    id: message.key,
    mode,
    source,
    output: stringField(raw, "output"),
    cancelled: raw.cancelled === true,
    truncated: raw.truncated === true,
    ...(typeof raw.exitCode === "number" ? { exitCode: raw.exitCode } : {}),
    ...(Array.isArray(raw.images) ? { images: raw.images } : {}),
    excludeFromContext: raw.excludeFromContext === true,
  };
}
