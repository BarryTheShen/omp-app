import { cn } from "cn";
import type { AgentStatus } from "@/modules/P1/contract";
import { type IconName, Icons } from "@/tokens";
import type { StatusPresentation, WorkerTone } from "./model";

/** The same tone classes as U3's tool-card chip, so a worker and a tool call read alike. */
const TONE_CLASSES: Readonly<Record<WorkerTone, string>> = {
  info: "border-info/30 bg-info-surface text-info-surface-foreground",
  success: "border-success/30 bg-success-surface text-success-surface-foreground",
  danger: "border-danger/30 bg-danger-surface text-danger-surface-foreground",
  muted: "border-border bg-muted text-muted-foreground",
  neutral: "border-border bg-secondary text-secondary-foreground",
};

const ICON_BY_STATUS: Readonly<Record<AgentStatus, IconName>> = {
  pending: "info",
  running: "loading",
  completed: "success",
  failed: "error",
  aborted: "warning",
};

export function StatusChip({ presentation }: { readonly presentation: StatusPresentation }) {
  const Icon = Icons[ICON_BY_STATUS[presentation.status]];
  const spinning = presentation.status === "running";
  return (
    <span
      className={cn(
        "inline-flex min-w-0 shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE_CLASSES[presentation.tone],
      )}
      data-status={presentation.status}
    >
      <Icon
        aria-hidden="true"
        className={
          spinning ? "size-3 motion-safe:animate-spin motion-reduce:animate-none" : "size-3"
        }
      />
      {presentation.label}
    </span>
  );
}
