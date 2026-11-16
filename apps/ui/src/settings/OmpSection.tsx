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

/** How often the job looks, in words: "Every night", "Every third night", "Every 7 nights". */
export function everyWords(nights: number): string {
  if (nights === 1) return "Every night";
  const ordinal = ORDINALS[nights];
  return ordinal === undefined || ordinal === ""
    ? `Every ${nights} nights`
    : `Every ${ordinal} night`;
}

/** A sentence's end: a full stop, unless the text already ends with one ("5 a.m."). */
const ended = (text: string): string => (text.endsWith(".") ? text : `${text}.`);

const range = (least: number, most: number): number[] =>
  Array.from({ length: most - least + 1 }, (_, index) => least + index);

const NIGHT_CHOICES = range(OMP_UPDATE_NIGHTS.least, OMP_UPDATE_NIGHTS.most).map((nights) => ({
  value: String(nights),
  label: nights === 1 ? "Every night" : `Every ${nights} nights`,
}));
const HOUR_CHOICES = range(OMP_UPDATE_HOURS.least, OMP_UPDATE_HOURS.most).map((hour) => ({
  value: String(hour),
  label: `${String(hour).padStart(2, "0")}:00`,
}));

/** One of the job's settings: its name and what it does, and the menu that changes it. */
function ScheduleRow(props: {
  readonly label: string;
  readonly detail: string;
  readonly value: number;
  readonly choices: readonly { readonly value: string; readonly label: string }[];
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}): ReactNode {
  return (
    <div className="flex items-center gap-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-t1">{props.label}</p>
        <p className="mt-0.5 text-xs text-t3">{props.detail}</p>
      </div>
      <Select
        items={props.choices}
        value={String(props.value)}
        disabled={props.disabled}
        onValueChange={(next) => {
          if (typeof next === "string" && Number(next) !== props.value)
            props.onChange(Number(next));
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
          {props.choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
            choices={NIGHT_CHOICES}
            disabled={saving}
            onChange={(everyNights) => save({ everyNights }, "How often was not saved")}
          />
          <ScheduleRow
            label="Install from"
            detail={ended(`A new omp that passed installs ${window}, when no reply is running`)}
            value={schedule.installHour}
            choices={HOUR_CHOICES}
            disabled={saving}
            onChange={(installHour) => save({ installHour }, "The install hour was not saved")}
          />
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
