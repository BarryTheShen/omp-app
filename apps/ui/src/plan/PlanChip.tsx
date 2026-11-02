import type { PlanModeStatus } from "@omp-app/contracts/chat-host";
import { cn } from "cn";
import { Map as MapIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChatController } from "../chat/controller";

/** omp's plan mode in the message box: pressed while it is on. Shown only where omp offers plan mode. */
export function PlanChip({
  controller,
  status,
  disabled,
  onError,
}: {
  readonly controller: ChatController;
  readonly status: PlanModeStatus | null;
  readonly disabled: boolean;
  readonly onError: (failure: unknown) => void;
}): ReactNode {
  if (status === null || !status.available) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            data-tour="plan"
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              "gap-1.5 text-t2 hover:text-t1 tablet:h-11",
              status.enabled && "bg-l2 text-t1",
            )}
            aria-pressed={status.enabled}
            aria-keyshortcuts="Alt+Shift+P"
            disabled={disabled}
            onClick={() => void controller.setPlanMode(!status.enabled).catch(onError)}
          />
        }
      >
        <MapIcon />
        Plan
      </TooltipTrigger>
      <TooltipContent>
        {status.enabled
          ? "Plan mode is on: omp plans and changes nothing until you approve. Alt+Shift+P"
          : "Plan mode: omp plans first and changes nothing until you approve. Alt+Shift+P"}
      </TooltipContent>
    </Tooltip>
  );
}
