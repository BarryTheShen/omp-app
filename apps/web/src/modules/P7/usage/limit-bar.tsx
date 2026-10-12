import type { UsageLimitWindow } from "@omp-app/contracts";
import { cn } from "@/lib/utils";
import { barPercent, type LimitTone, limitTone, resetAtWords, resetsInWords } from "./limit-words";

const FILL: Record<LimitTone, string> = {
  normal: "bg-primary",
  warning: "bg-warning",
  danger: "bg-danger",
};

/**
 * One usage window of one provider, drawn as a bar: its share used filled, the percentage beside it, and the time left
 * until it resets (the clock time is the tooltip). The bar is a progress bar named for its provider and window.
 */
export function LimitBar({
  providerId,
  window,
  now,
}: {
  readonly providerId: string;
  readonly window: UsageLimitWindow;
  readonly now: Date;
}) {
  const known = Number.isFinite(window.usedPercent);
  const fill = barPercent(window.usedPercent);
  const tone = limitTone(window.usedPercent);
  const percentText = known ? `${Math.round(window.usedPercent)}% used` : "usage unknown";
  const reset = resetsInWords(window.resetsAt, now);
  const accounts = window.accounts > 1 ? ` (the fullest of ${window.accounts} accounts)` : "";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-foreground">{window.label}</span>
      <div className="flex items-center gap-2">
        <div
          role="progressbar"
          aria-label={`${providerId}, ${window.label.toLowerCase()} limit`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={known ? Math.round(fill) : undefined}
          aria-valuetext={`${percentText}, ${reset}`}
          data-tone={tone}
          className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/15"
        >
          <div className={cn("h-full rounded-full", FILL[tone])} style={{ width: `${fill}%` }} />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-foreground">{percentText}</span>
      </div>
      <p className="text-xs text-muted-foreground" title={resetAtWords(window.resetsAt, now)}>
        {reset}
        {accounts}
      </p>
    </div>
  );
}
