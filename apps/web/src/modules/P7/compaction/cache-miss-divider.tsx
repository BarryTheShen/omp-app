import type { OmpWire } from "@omp-app/contracts";
import { CustomMessageRow } from "@/modules/U1/rows";
import { cacheMissBetween, formatTokenCount } from "./models";

export interface CacheMissDividerProps {
  /** The immediately preceding assistant turn's usage, or null at the start of a session. */
  readonly previousAssistantUsage: OmpWire.Usage | null;
  /** The assistant turn that follows this divider. */
  readonly currentAssistantUsage: OmpWire.Usage;
}

export function CacheMissDivider({
  previousAssistantUsage,
  currentAssistantUsage,
}: CacheMissDividerProps) {
  const miss = cacheMissBetween(previousAssistantUsage, currentAssistantUsage);
  if (miss === null) return null;

  const tokens = formatTokenCount(miss.reprocessedTokens);
  return (
    <div data-p7-cache-miss-divider>
      <CustomMessageRow
        content={`The prompt cache went cold, so omp processed ${tokens} tokens again.`}
        customType="Prompt cache update"
        title="Prompt cache missed"
      />
    </div>
  );
}
