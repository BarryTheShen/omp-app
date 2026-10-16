import { Section } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { SurfaceNotice } from "../tools/notice";
import type { D74Command, D74CommandSurface } from "./commands";

export interface PrewalkSurfaceProps {
  readonly surface: D74CommandSurface;
  readonly canRun: boolean;
  readonly onRun: (command: D74Command) => void;
  readonly onRetry: () => void;
}

/** Presents one-time model handoff and context-removal controls without interpreting command text. */
export function PrewalkSurface({ surface, canRun, onRun, onRetry }: PrewalkSurfaceProps) {
  const disabled = !canRun || surface.state === "requested" || surface.state === "confirming";
  return (
    <Section
      heading="Preparation and context"
      description="Control when omp switches to a faster model and what stays in its context."
    >
      <div className="flex flex-col gap-3">
        <fieldset className="flex flex-wrap gap-2" aria-label="Model switch actions">
          <Button
            disabled={disabled}
            onClick={() => onRun("/prewalk")}
            title="Arm a one-time switch to a faster model at the next edit or write after omp has a to-do list."
            variant="outline"
          >
            Switch model at the next edit
          </Button>
          <Button
            disabled={disabled}
            onClick={() => onRun("/prewalk restart")}
            title="Return to the default model and arm the one-time switch again."
            variant="outline"
          >
            Reset model and re-arm the switch
          </Button>
          <Button
            disabled={disabled}
            onClick={() => onRun("/prewalk off")}
            title="Cancel the armed one-time model switch."
            variant="outline"
          >
            Cancel the model switch
          </Button>
        </fieldset>
        <fieldset className="flex flex-wrap gap-2" aria-label="Context removal actions">
          <Button
            disabled={disabled}
            onClick={() => onRun("/shake elide")}
            title="Remove tool results and large blocks from context."
            variant="outline"
          >
            Drop tool results and large blocks
          </Button>
          <Button
            disabled={disabled}
            onClick={() => onRun("/shake images")}
            title="Remove images from context."
            variant="outline"
          >
            Drop images from context
          </Button>
          <Button
            disabled={disabled}
            onClick={() => onRun("/shake thinking")}
            title="Remove thinking from context."
            variant="outline"
          >
            Drop thinking from context
          </Button>
        </fieldset>
        {surface.state === "unavailable" ||
        surface.state === "requested" ||
        surface.command?.startsWith("/prewalk") ||
        surface.command?.startsWith("/shake") ? (
          <SurfaceNotice onRetry={onRetry} surface={surface} />
        ) : null}
      </div>
    </Section>
  );
}
