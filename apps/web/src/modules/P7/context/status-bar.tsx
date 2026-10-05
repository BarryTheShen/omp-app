import type { ContextUsagePort, UsagePort } from "../contract";
import { UsagePopover } from "../usage";
import { ContextMeter } from "./context-meter";

export function ContextStatusBar({
  context,
  usage,
}: {
  readonly context: ContextUsagePort;
  readonly usage: UsagePort;
}) {
  return (
    <section aria-label="Context status" className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <ContextMeter port={context} />
      </div>
      <UsagePopover port={usage} />
    </section>
  );
}
