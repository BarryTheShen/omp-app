import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { HourFace } from "../settings/HourDial";
import { localInput } from "./taskTime";

/** The minutes a time can be set to. */
export const MINUTES = [0, 15, 30, 45] as const;
const QUARTER_MS = 15 * 60_000;

const two = (value: number): string => String(value).padStart(2, "0");

/** An hour from `now`, to the next quarter: the time a message for later starts at, and the first quick time. */
export const inAnHour = (now: number): number =>
  Math.ceil((now + 60 * 60_000) / QUARTER_MS) * QUARTER_MS;

/** The quick choices above the picker, from `now`: in an hour (to the next quarter), tonight at 11 p.m., tomorrow at 9. */
export function quickTimes(now: number): { readonly label: string; readonly at: number }[] {
  const at = (days: number, hour: number): number => {
    const day = new Date(now);
    day.setDate(day.getDate() + days);
    day.setHours(hour, 0, 0, 0);
    return day.getTime();
  };
  const tonight = at(0, 23);
  return [
    { label: "In an hour", at: inAnHour(now) },
    tonight > now
      ? { label: "Tonight, 11 p.m.", at: tonight }
      : { label: "Tomorrow night, 11 p.m.", at: at(1, 23) },
    { label: "Tomorrow, 9 a.m.", at: at(1, 9) },
  ];
}

/** When a time set in the picker goes, in words: "Mon, Nov 16, 9:15 PM". */
export function timeWords(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A day and a time that every browser lets you pick (a `datetime-local` field pops up only a calendar in Firefox and
 * Zen, its time typed): quick choices, the day in the browser's date field, the hour on a clock and the minutes. The
 * value is local time as `datetime-local` takes it (`YYYY-MM-DDTHH:MM`, see `taskTime.ts`).
 */
export function WhenPicker({
  value,
  onChange,
  phone,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly phone: boolean;
}): ReactNode {
  const [day = "", time = "00:00"] = value.split("T");
  const hour = Number(time.slice(0, 2)) || 0;
  const minute = Number(time.slice(3, 5)) || 0;
  const set = (nextDay: string, nextHour: number, nextMinute: number): void =>
    onChange(`${nextDay}T${two(nextHour)}:${two(nextMinute)}`);
  const at = new Date(value).getTime();
  return (
    <div className="flex flex-col gap-2">
      <fieldset aria-label="Quick times" className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0">
        {quickTimes(Date.now()).map((quick) => (
          <Button
            key={quick.label}
            type="button"
            size="sm"
            variant="outline"
            className={`dark:bg-transparent ${phone ? "h-11" : ""}`}
            onClick={() => onChange(localInput(quick.at))}
          >
            {quick.label}
          </Button>
        ))}
      </fieldset>
      <Input
        aria-label="Day"
        type="date"
        className={`dark:bg-transparent ${phone ? "h-11" : "tablet:h-11"}`}
        value={day}
        onChange={(event) => {
          if (event.target.value !== "") set(event.target.value, hour, minute);
        }}
      />
      <HourFace label="Hour" value={hour} onChoose={(next) => set(day, next, minute)} />
      <ToggleGroup
        aria-label="Minutes"
        className="justify-center"
        value={[String(minute)]}
        onValueChange={(next: string[]) => {
          const picked = next[0];
          if (picked !== undefined) set(day, hour, Number(picked));
        }}
      >
        {[...new Set([...MINUTES, minute])]
          .sort((a, b) => a - b)
          .map((each) => (
            <ToggleGroupItem
              key={each}
              value={String(each)}
              size="sm"
              aria-label={`:${two(each)}`}
              className={`tabular-nums ${phone ? "h-11 min-w-11" : ""}`}
            >
              :{two(each)}
            </ToggleGroupItem>
          ))}
      </ToggleGroup>
      <p role="status" className="text-center text-xs text-t2">
        {Number.isFinite(at) ? `Goes ${timeWords(at)}` : "Pick a day."}
      </p>
    </div>
  );
}
