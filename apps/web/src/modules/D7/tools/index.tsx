import { EmptyState, Section } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type { ToolAvailability, ToolAvailabilityState } from "../contract";
import { MODE_LABELS } from "../modes/commands";
import type { D74CommandSurface } from "../prewalk/commands";
import { SurfaceNotice } from "./notice";

const AVAILABILITY_LABEL: Readonly<Record<ToolAvailabilityState, string>> = {
  available: "Available",
  fallback: "Limited",
  unavailable: "Unavailable",
  unknown: "Not confirmed",
};

export interface ToolAvailabilitySurfaceProps {
  readonly tools: readonly ToolAvailability[];
  readonly surface: D74CommandSurface;
  readonly canRun: boolean;
  readonly onList: () => void;
  readonly onSkillful: (
    command: "/skillful on" | "/skillful off" | "/skillful status" | "/skillful toggle",
  ) => void;
  readonly onRetry: () => void;
}

/** Displays D7.1 availability data and the typed `/tools` result without taking tool-policy ownership. */
export function ToolAvailabilitySurface({
  tools,
  surface,
  canRun,
  onList,
  onSkillful,
  onRetry,
}: ToolAvailabilitySurfaceProps) {
  const disabled = !canRun || surface.state === "requested" || surface.state === "confirming";
  return (
    <Section heading="Tools and skills" description="See what omp can use in this chat.">
      <div className="flex flex-col gap-3">
        <fieldset className="flex flex-wrap gap-2" aria-label="Tool actions">
          <Button disabled={disabled} onClick={onList} variant="outline">
            Refresh available tools
          </Button>
          <Button disabled={disabled} onClick={() => onSkillful("/skillful on")} variant="outline">
            Show skills in prompts
          </Button>
          <Button
            disabled={disabled}
            onClick={() => onSkillful("/skillful status")}
            variant="outline"
          >
            Check skill listing
          </Button>
          <Button
            disabled={disabled}
            onClick={() => onSkillful("/skillful toggle")}
            variant="outline"
          >
            Toggle skill listing
          </Button>
          <Button disabled={disabled} onClick={() => onSkillful("/skillful off")} variant="outline">
            Hide skills in prompts
          </Button>
        </fieldset>
        {surface.state === "unavailable" ||
        surface.state === "requested" ||
        surface.command === "/tools" ||
        surface.command?.startsWith("/skillful ") ? (
          <SurfaceNotice onRetry={onRetry} surface={surface} />
        ) : null}
        {tools.length > 0 ? (
          <ul className="flex min-w-0 flex-col gap-2" aria-label="Tool availability">
            {tools.map((tool) => (
              <li
                className="border-border flex min-w-0 flex-col rounded-lg border px-3 py-2"
                key={`${tool.tool}-${tool.mode ?? "all"}`}
              >
                <span className="font-medium">{tool.tool}</span>
                <span className="text-muted-foreground text-sm">
                  {AVAILABILITY_LABEL[tool.state]}
                  {tool.mode ? ` · ${MODE_LABELS[tool.mode]}` : ""}
                  {tool.reason ? ` · ${tool.reason}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No tool availability reported"
            hint="Refresh the list to ask omp which tools are available in this chat."
            variant="compact"
          />
        )}
      </div>
    </Section>
  );
}
