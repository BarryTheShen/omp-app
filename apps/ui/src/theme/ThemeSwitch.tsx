import { Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { setThemeChoice, type ThemeChoice, useThemeChoice } from "./theme";

/** The themes to choose from, as the switch and a phone's menu offer them. */
export const THEME_CHOICES: readonly { value: ThemeChoice; label: string; icon: ReactNode }[] = [
  { value: "system", label: "Match the system", icon: <Monitor /> },
  { value: "tern-light", label: "Light", icon: <Sun /> },
  { value: "tern-dark", label: "Dark", icon: <Moon /> },
];

/** The theme in one click: match the system, light or dark. */
export function ThemeSwitch(): ReactNode {
  const choice = useThemeChoice();
  return (
    <ToggleGroup
      aria-label="Theme"
      data-tour="theme"
      size="sm"
      spacing={0.5}
      className="rounded-lg border border-l2 p-0.5"
      value={[choice]}
      onValueChange={(next) => {
        const picked = THEME_CHOICES.find((item) => item.value === next[0]);
        if (picked !== undefined) setThemeChoice(picked.value);
      }}
    >
      {THEME_CHOICES.map(({ value, label, icon }) => (
        <Tooltip key={value}>
          <TooltipTrigger
            render={
              <ToggleGroupItem
                value={value}
                aria-label={label}
                className="text-t3 hover:text-t1 aria-pressed:bg-l2 aria-pressed:text-t1"
              />
            }
          >
            {icon}
          </TooltipTrigger>
          <TooltipContent side="top">{label}</TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}
