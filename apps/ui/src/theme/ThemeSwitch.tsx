import { Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { setThemeMode, type ThemeMode, useThemeMode } from "./theme";

/** The switch's choices, as the switch and a phone's menu offer them: Light and Dark are your light and dark themes. */
export const THEME_CHOICES: readonly { value: ThemeMode; label: string; icon: ReactNode }[] = [
  { value: "system", label: "Match the system", icon: <Monitor /> },
  { value: "light", label: "Light", icon: <Sun /> },
  { value: "dark", label: "Dark", icon: <Moon /> },
];

/** The theme in one click: match the system, or your light or your dark theme (the gallery picks them). */
export function ThemeSwitch(): ReactNode {
  const mode = useThemeMode();
  return (
    <ToggleGroup
      aria-label="Theme"
      data-tour="theme"
      size="sm"
      spacing={0.5}
      className="rounded-lg border border-l2 p-0.5"
      value={[mode]}
      onValueChange={(next) => {
        const picked = THEME_CHOICES.find((item) => item.value === next[0]);
        if (picked !== undefined) setThemeMode(picked.value);
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
