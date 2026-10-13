import type { MessageState } from "@assistant-ui/react";
import type { OmpWire } from "@omp-app/contracts";
import type { CacheMissDividerProps } from "./cache-miss-divider";
import { CacheMissDivider } from "./cache-miss-divider";
import { cacheMissBetween } from "./models";

/** omp's usage figures, or undefined when the value is not a usage record. */
function usageOf(value: unknown): OmpWire.Usage | undefined {
  return typeof value === "object" && value !== null ? (value as OmpWire.Usage) : undefined;
}

/**
 * The cache-miss row for an assistant turn whose prompt cache went cold after the turn before it (see `cacheMissBetween`).
 * R0 keeps omp's usage of this turn and of the one before it in the row's metadata; any other row, or one without both
 * usages, gives undefined.
 */
export function cacheMissOfRow(message: MessageState): CacheMissDividerProps | undefined {
  const { ompRole, ompUsage, ompPreviousUsage } = message.metadata.custom;
  if (ompRole !== "assistant") return undefined;
  const current = usageOf(ompUsage);
  const previous = ompPreviousUsage === null ? null : usageOf(ompPreviousUsage);
  if (current === undefined || previous === undefined) return undefined;
  if (cacheMissBetween(previous, current) === null) return undefined;
  return { previousAssistantUsage: previous, currentAssistantUsage: current };
}

/** The miss row above a turn whose cache went cold. Every other row renders nothing. */
export function CacheMissRow({ message }: { readonly message: MessageState }) {
  const miss = cacheMissOfRow(message);
  return miss === undefined ? null : <CacheMissDivider {...miss} />;
}
