import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import type { ComponentType, KeyboardEvent } from "react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { setThemePreference, useThemePreference } from "./store";
import { THEME_PREFERENCES, type ThemePreference } from "./theme";

const CHOICES: Readonly<
  Record<
    ThemePreference,
    { readonly label: string; readonly Icon: ComponentType<{ className?: string }> }
  >
> = {
  system: { label: "System", Icon: MonitorIcon },
  light: { label: "Light", Icon: SunIcon },
  dark: { label: "Dark", Icon: MoonIcon },
};

/**
 * The theme choice, always on screen: "Theme" and three buttons, System (the default, follows the
 * browser's own dark or light setting), Light and Dark. One group with one tab stop; the arrow keys
 * move between the three, as in any radio group.
 */
export function ThemeButton() {
  const preference = useThemePreference();
  const buttons = useRef<Partial<Record<ThemePreference, HTMLButtonElement | null>>>({});

  const choose = (next: ThemePreference): void => {
    setThemePreference(next);
    buttons.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: ThemePreference): void => {
    // Alt, Ctrl, Meta and Shift combinations belong to the browser (Alt+Left is Back): only plain arrows step.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = THEME_PREFERENCES.indexOf(current);
    const next =
      THEME_PREFERENCES[(index + step + THEME_PREFERENCES.length) % THEME_PREFERENCES.length];
    if (next !== undefined) choose(next);
  };

  return (
    <div
      className="flex items-center justify-between gap-2 px-(--space-md) py-(--space-xs)"
      data-slot="theme-button"
    >
      <span className="text-muted-foreground text-sm" id="theme-button-label">
        Theme
      </span>
      <div
        aria-labelledby="theme-button-label"
        className="flex items-center gap-1"
        role="radiogroup"
      >
        {THEME_PREFERENCES.map((choice) => {
          const { label, Icon } = CHOICES[choice];
          const selected = choice === preference;
          return (
            <Button
              aria-checked={selected}
              aria-label={label}
              className={cn(selected && "bg-muted text-foreground")}
              data-theme-choice={choice}
              key={choice}
              onClick={() => choose(choice)}
              onKeyDown={(event) => onKeyDown(event, choice)}
              ref={(element) => {
                buttons.current[choice] = element;
              }}
              role="radio"
              size="icon-sm"
              tabIndex={selected ? 0 : -1}
              title={
                choice === "system" ? "System: follows your browser's dark or light setting" : label
              }
              type="button"
              variant="ghost"
            >
              <Icon className="size-4" />
            </Button>
          );
        })}
      </div>
    </div>
  );
}
