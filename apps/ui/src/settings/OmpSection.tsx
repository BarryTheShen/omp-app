import type { AppClient } from "@omp-app/client";
import {
  AppPort,
  OMP_UPDATE_HOURS,
  OMP_UPDATE_NIGHTS,
  type OmpUpdates,
  type SetOmpUpdatesArgs,
} from "@omp-app/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { HourDial } from "./HourDial";

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/** "Nov 13": the day a night's run began, in this browser's time. */
const dayOf = (at: string): string =>
  new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** "2:14 PM": when Update now was asked, in this browser's time. */
const timeOf = (at: string): string =>
  new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/** An hour of the day in words: "midnight", "3 a.m.", "noon", "9 p.m.". */
function hourWords(hour: number): string {
  if (hour === 0 || hour === 24) return "midnight";
  if (hour === 12) return "noon";
  return hour < 12 ? `${hour} a.m.` : `${hour - 12} p.m.`;
}

/** The install's two hours in words, as the job says them: "between 3 and 5 a.m.", "between 11 a.m. and 1 p.m.". */
export function windowWords(installHour: number): string {
  const end = installHour + 2;
  const to = hourWords(end);
  if (installHour >= 1 && end < 12) return `between ${installHour} and ${to}`;
  if (installHour >= 13 && end < 24) return `between ${installHour - 12} and ${to}`;
  return `between ${hourWords(installHour)} and ${to}`;
}

const ORDINALS = ["", "", "second", "third"] as const;

/** How often the job looks, in words: "Every night", "Every third night", "Every week", "Every 5 nights". */
export function everyWords(nights: number): string {
  if (nights === 1) return "Every night";
  if (nights === 7) return "Every week";
  if (nights === 14) return "Every 2 weeks";
  const ordinal = ORDINALS[nights];
  return ordinal === undefined || ordinal === ""
    ? `Every ${nights} nights`
    : `Every ${ordinal} night`;
}

/** A sentence's end: a full stop, unless the text already ends with one ("5 a.m."). */
const ended = (text: string): string => (text.endsWith(".") ? text : `${text}.`);

/** A menu's row for a number of nights: "Every night", "Every 2 nights", "Every week", "Every 2 weeks". */
export const nightsLabel = (nights: number): string =>
  nights === 1
    ? "Every night"
    : nights === 7
      ? "Every week"
      : nights === 14
        ? "Every 2 weeks"
        : `Every ${nights} nights`;

/** A menu's few usual choices; any other value is set with Custom… at its foot. */
export const NIGHT_PRESETS = [1, 2, 3, 7, 14] as const;

/** The value of the menu's Custom… row, which opens a field for any value in the range. */
const CUSTOM = "custom";

/**
 * A menu's rows: the presets, the value now set when it is none of them (in its place by size), and Custom… last.
 */
export function menuChoices(
  presets: readonly number[],
  value: number,
  label: (value: number) => string,
): { readonly value: string; readonly label: string }[] {
  const shown = presets.includes(value) ? [...presets] : [...presets, value].sort((a, b) => a - b);
  return [
    ...shown.map((each) => ({ value: String(each), label: label(each) })),
    { value: CUSTOM, label: "Custom…" },
  ];
}

/** One of the job's settings: its name and what it does, a menu of usual values, and Custom… for any other. */
function ScheduleRow(props: {
  readonly label: string;
  readonly detail: string;
  readonly value: number;
  readonly presets: readonly number[];
  readonly choiceLabel: (value: number) => string;
  /** The Custom… field: its range and the word after it ("nights"). */
  readonly custom: { readonly least: number; readonly most: number; readonly unit: string };
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}): ReactNode {
  const [typing, setTyping] = useState<string | null>(null);
  const choices = menuChoices(props.presets, props.value, props.choiceLabel);
  const typed = typing === null ? Number.NaN : Number(typing);
  const valid =
    Number.isInteger(typed) && typed >= props.custom.least && typed <= props.custom.most;
  const set = (): void => {
    if (!valid) return;
    setTyping(null);
    if (typed !== props.value) props.onChange(typed);
  };
  return (
    <div className="py-3">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-t1">{props.label}</p>
          <p className="mt-0.5 text-xs text-t3">{props.detail}</p>
        </div>
        <Select
          items={choices}
          value={String(props.value)}
          disabled={props.disabled}
          onValueChange={(next) => {
            if (next === CUSTOM) setTyping(String(props.value));
            else if (typeof next === "string") {
              setTyping(null);
              if (Number(next) !== props.value) props.onChange(Number(next));
            }
          }}
        >
          <SelectTrigger
            aria-label={props.label}
            size="sm"
            className="min-w-36 justify-between dark:bg-transparent"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {choices.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {typing !== null && (
        <form
          className="mt-2 flex items-center justify-end gap-2 text-xs text-t2"
          onSubmit={(event) => {
            event.preventDefault();
            set();
          }}
        >
          <input
            type="number"
            aria-label={`${props.label}, custom`}
            min={props.custom.least}
            max={props.custom.most}
            step={1}
            // biome-ignore lint/a11y/noAutofocus: opened by choosing Custom…, for typing the number at once
            autoFocus
            value={typing}
            onChange={(event) => setTyping(event.target.value)}
            className="h-7 w-16 rounded-md border border-l2 bg-transparent px-2 text-sm text-t1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <span>
            {props.custom.unit} ({props.custom.least} to {props.custom.most})
          </span>
          <Button type="submit" size="sm" variant="secondary" disabled={!valid || props.disabled}>
            Set
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setTyping(null)}>
            Cancel
          </Button>
        </form>
      )}
    </div>
  );
}

/** While an Update now waits or runs, the section reads the job's word again this often. */
const FOLLOW_MS = 10_000;

/**
 * Settings → App → omp: the omp release the app runs; and where a job beside the app updates omp at night (one that
 * writes `<app data>/omp-update.json`), automatic updates on or off, how often it looks for a new omp and from when it
 * installs one, Update now, what its last run came to and what it does now, a new omp ready to move to, and why updates
 * stopped, when they did.
 */
export function OmpSection({ client }: { readonly client: AppClient }): ReactNode {
  const [version, setVersion] = useState<string | null | undefined>(undefined);
  const [updates, setUpdates] = useState<OmpUpdates | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const app = client.port(AppPort);
    app.serverInfo({}).then(
      (info) => alive && setVersion(info.omp?.version ?? null),
      () => undefined,
    );
    app.ompUpdates({}).then(
      (next) => alive && setUpdates(next),
      (failure: unknown) =>
        alive && setProblem(`What the omp updates last did could not be read: ${words(failure)}`),
    );
    return () => {
      alive = false;
    };
  }, [client]);
  const job = updates?.job ?? null;
  // An Update now waiting for the job, or the job at work: its word is read again until it is done.
  const following = updates !== null && (updates.request !== null || job?.running !== undefined);
  useEffect(() => {
    if (!following) return;
    let alive = true;
    const timer = setInterval(() => {
      client
        .port(AppPort)
        .ompUpdates({})
        .then(
          (next) => alive && setUpdates(next),
          () => undefined,
        );
    }, FOLLOW_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, following]);

  const save = (change: SetOmpUpdatesArgs, failed: string): void => {
    setSaving(true);
    setProblem(null);
    client
      .port(AppPort)
      .setOmpUpdates(change)
      .then(
        (next) => setUpdates(next),
        (failure: unknown) => setProblem(`${failed}: ${words(failure)}`),
      )
      .finally(() => setSaving(false));
  };
  const updateNow = (): void => {
    setSaving(true);
    setProblem(null);
    client
      .port(AppPort)
      .requestOmpUpdate({})
      .then(
        (next) => setUpdates(next),
        (failure: unknown) => setProblem(`Update now was not asked: ${words(failure)}`),
      )
      .finally(() => setSaving(false));
  };

  const schedule = updates?.schedule;
  const window = schedule === undefined ? "" : windowWords(schedule.installHour);
  return (
    <section aria-label="omp" data-tour="omp-updates">
      <h3 className="mt-6 text-xs font-medium text-t3">omp</h3>
      <p className="mt-2 text-sm text-t2">
        {version === undefined
          ? "\u00a0"
          : version === null
            ? "This server found no omp to run."
            : `Your chats run on omp ${version}.`}
      </p>
      {updates !== null && schedule !== undefined && job !== null && (
        <>
          <div className="flex items-center gap-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-t1">Automatic updates</p>
              <p className="mt-0.5 text-xs text-t3">
                {ended(
                  `${everyWords(schedule.everyNights)} a newer omp is tested on its own. When it passes, the app moves to it ${window}, with every chat paused across the move`,
                )}
              </p>
            </div>
            <Switch
              aria-label="Automatic omp updates"
              checked={updates.enabled}
              disabled={saving}
              onCheckedChange={(enabled) => save({ enabled }, "The switch was not saved")}
            />
          </div>
          <ScheduleRow
            label="Look for a new omp"
            detail="How often the job looks for a newer omp to test."
            value={schedule.everyNights}
            presets={NIGHT_PRESETS}
            choiceLabel={nightsLabel}
            custom={{
              least: OMP_UPDATE_NIGHTS.least,
              most: OMP_UPDATE_NIGHTS.most,
              unit: "nights",
            }}
            disabled={saving}
            onChange={(everyNights) => save({ everyNights }, "How often was not saved")}
          />
          <div className="flex items-center gap-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-t1">Install from</p>
              <p className="mt-0.5 text-xs text-t3">
                {ended(`A new omp that passed installs ${window}, when no reply is running`)}
              </p>
            </div>
            <HourDial
              label="Install from"
              value={schedule.installHour}
              least={OMP_UPDATE_HOURS.least}
              most={OMP_UPDATE_HOURS.most}
              length={2}
              disabled={saving}
              onChange={(installHour) => save({ installHour }, "The install hour was not saved")}
            />
          </div>
          <div className="flex items-center gap-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-t1">Update now</p>
              <p className="mt-0.5 text-xs text-t3">
                {ended(
                  `Looks for a newer omp now and tests it on its own, which takes about 45 minutes. One that passes installs ${window}, also while automatic updates are off`,
                )}
              </p>
            </div>
            <Button size="sm" variant="outline" disabled={saving || following} onClick={updateNow}>
              Update now
            </Button>
          </div>
          {updates.request !== null && job.running === undefined && (
            <p role="status" className="text-xs text-t2">
              Update now, asked at {timeOf(updates.request.at)}: it starts in a moment.
            </p>
          )}
          {job.running !== undefined && (
            <p role="status" className="text-xs text-t2">
              {job.running}
            </p>
          )}
          <p className="mt-1 text-xs text-t3">
            Last run, {dayOf(job.lastNight.at)}: {job.lastNight.result}
          </p>
          {job.pending !== undefined && (
            <p className="mt-1 text-xs text-t2">
              {updates.enabled || job.byRequest === true
                ? ended(`omp ${job.pending} is ready: the app moves to it ${window}`)
                : `omp ${job.pending} is ready, and waits until automatic updates are on.`}
            </p>
          )}
          {job.blocked !== undefined && (
            <p role="alert" className="mt-1 text-xs text-bad-ink">
              Updates stopped until someone looks: {job.blocked}
            </p>
          )}
        </>
      )}
      {problem !== null && (
        <p role="alert" className="mt-2 text-sm text-bad-ink">
          {problem}
        </p>
      )}
    </section>
  );
}
