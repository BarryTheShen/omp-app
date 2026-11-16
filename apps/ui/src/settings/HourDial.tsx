import { cn } from "cn";
import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { usePhone } from "@/phone";

/** An hour in words, as the dial reads it out: "12 a.m.", "3 a.m.", "12 p.m.", "9 p.m.". */
export function dialHourWords(hour: number): string {
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${hour < 12 ? "a.m." : "p.m."}`;
}

/** The dial's size and its two rings, a.m. hours outside and p.m. hours inside; larger on a phone, for a finger. */
interface Dial {
  readonly size: number;
  readonly outer: number;
  readonly inner: number;
  readonly button: number;
}
const DESK: Dial = { size: 216, outer: 88, inner: 56, button: 28 };
const PHONE: Dial = { size: 296, outer: 124, inner: 80, button: 40 };
/** The day's hours, 0 to 23. */
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const ringOf = (dial: Dial, hour: number): number => (hour < 12 ? dial.outer : dial.inner);
/** Where an hour sits: 12 at the top, clockwise, as on a clock. */
function point(dial: Dial, hour: number, radius: number): { x: number; y: number } {
  const angle = ((hour % 12) / 12) * 2 * Math.PI - Math.PI / 2;
  const center = dial.size / 2;
  return { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle) };
}

/** The arc of one hour of the window on its ring, from the hour's mark to the next. */
function hourArc(dial: Dial, hour: number): string {
  const radius = ringOf(dial, hour);
  const from = point(dial, hour, radius);
  const to = point(dial, hour + 1, radius);
  return `M ${from.x} ${from.y} A ${radius} ${radius} 0 0 1 ${to.x} ${to.y}`;
}

/**
 * The day's 24 hours on a clock, a.m. on the outer ring and p.m. on the inner: a click (or Enter on the hour the arrow
 * keys moved to) chooses one. With `length`, the window from the chosen hour is drawn as an arc; hours outside `least`
 * to `most` are greyed. Shown in a popup by `HourDial`, or as it is inside a form.
 */
export function HourFace(props: {
  readonly label: string;
  readonly value: number;
  readonly least?: number;
  readonly most?: number;
  /** How many hours the window from the chosen hour lasts; 0 draws none. */
  readonly length?: number;
  readonly onChoose: (hour: number) => void;
}): ReactNode {
  const dial = usePhone() ? PHONE : DESK;
  const least = props.least ?? 0;
  const most = props.most ?? 23;
  /** The hour the keys have moved to, before it is chosen. */
  const [focus, setFocus] = useState(props.value);
  // A value changed from outside (a quick pick beside the dial) moves the highlight with it.
  useEffect(() => setFocus(props.value), [props.value]);
  const allowed = (hour: number): boolean => hour >= least && hour <= most;
  const choose = (hour: number): void => {
    if (!allowed(hour)) return;
    setFocus(hour);
    props.onChoose(hour);
  };
  const window = Array.from({ length: props.length ?? 0 }, (_, k) => (focus + k) % 24);
  const onKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>): void => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step !== 0) {
      event.preventDefault();
      const next = Math.min(most, Math.max(least, focus + step));
      setFocus(next);
      (event.currentTarget.querySelector(`[data-hour="${next}"]`) as HTMLElement | null)?.focus();
    }
  };
  return (
    <>
      <fieldset
        aria-label={props.label}
        className="relative m-0 mx-auto min-w-0 border-0 p-0"
        style={{ width: dial.size, height: dial.size }}
        onKeyDown={onKeyDown}
      >
        <svg aria-hidden="true" width={dial.size} height={dial.size} className="absolute inset-0">
          <circle cx={dial.size / 2} cy={dial.size / 2} r={dial.size / 2 - 2} className="fill-l1" />
          {window.map((hour) => (
            <path
              key={hour}
              d={hourArc(dial, hour)}
              className="fill-none stroke-primary/50"
              strokeWidth={dial.button}
              strokeLinecap="round"
            />
          ))}
        </svg>
        {HOURS.map((hour) => {
          const at = point(dial, hour, ringOf(dial, hour));
          const on = hour === focus;
          const twelve = hour % 12 === 0 ? 12 : hour % 12;
          return (
            <button
              key={hour}
              type="button"
              data-hour={hour}
              aria-pressed={hour === props.value}
              aria-label={dialHourWords(hour)}
              disabled={!allowed(hour)}
              tabIndex={hour === focus ? 0 : -1}
              onClick={() => choose(hour)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  choose(hour);
                }
              }}
              className={cn(
                "absolute flex items-center justify-center rounded-full tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
                hour < 12
                  ? "text-[0.8125rem] text-t1 max-sm:text-base"
                  : "text-xs text-t2 max-sm:text-sm",
                on && "bg-primary font-medium text-primary-foreground",
                !on && "hover:bg-l2",
                "disabled:pointer-events-none disabled:text-t3/40",
              )}
              style={{
                width: dial.button,
                height: dial.button,
                left: at.x - dial.button / 2,
                top: at.y - dial.button / 2,
              }}
            >
              {twelve}
            </button>
          );
        })}
      </fieldset>
      {(props.length ?? 0) > 0 && (
        <p className="mt-2 text-center text-xs text-t2">
          From {dialHourWords(focus)} to {dialHourWords((focus + (props.length ?? 0)) % 24)}
        </p>
      )}
      <p className="text-center text-[11px] text-t3">a.m. on the outer ring, p.m. on the inner</p>
    </>
  );
}

/**
 * The install hour on a clock: a button reading the hour ("03:00") opens `HourFace`, with the window from the chosen
 * hour (`length` hours) drawn as an arc. Hours past `most` are greyed (the window must end by 11 p.m.).
 */
export function HourDial(props: {
  readonly label: string;
  readonly value: number;
  readonly least: number;
  readonly most: number;
  /** How many hours the window from the chosen hour lasts. */
  readonly length: number;
  readonly disabled: boolean;
  readonly onChange: (hour: number) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-w-36 justify-between tabular-nums dark:bg-transparent"
            aria-label={`${props.label}: ${dialHourWords(props.value)}`}
            disabled={props.disabled}
          />
        }
      >
        {`${String(props.value).padStart(2, "0")}:00`}
        <span className="text-xs text-t3">{dialHourWords(props.value)}</span>
      </PopoverTrigger>
      <PopoverContent aria-label={props.label} className="w-auto p-3">
        <HourFace
          label={props.label}
          value={props.value}
          least={props.least}
          most={props.most}
          length={props.length}
          onChoose={(hour) => {
            setOpen(false);
            if (hour !== props.value) props.onChange(hour);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
