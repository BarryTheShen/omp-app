import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  OMP_UPDATE_HOURS,
  OMP_UPDATE_NIGHTS,
  type OmpUpdateJob,
  type OmpUpdateSchedule,
  type OmpUpdates,
  OmpUpdateSchedule as ScheduleShape,
  type SetOmpUpdatesArgs,
} from "@omp-app/contracts";
import { z } from "zod";

/**
 * The files of a job that updates omp beside the app, in the app's data folder, one writer each so neither undoes the
 * other: the job writes `status` after every night (and while a long run goes on); the app writes `settings` when
 * Settings → App → omp changes them, and `request` when Update now is pressed. The job reads `settings` before it does
 * anything, and takes `request` away when it starts on it.
 */
export interface OmpUpdateFiles {
  readonly status: string;
  readonly settings: string;
  readonly request: string;
}

/** The job's file: `{ "version": 1, "lastNight": { "at", "result" }, "running"?, "pending"?, "byRequest"?, "blocked"? }`; other fields are its own. */
const StatusFile = z.object({
  version: z.literal(1),
  lastNight: z.object({ at: z.string().min(1), result: z.string().min(1) }),
  running: z.string().min(1).optional(),
  pending: z.string().min(1).optional(),
  byRequest: z.literal(true).optional(),
  blocked: z.string().min(1).optional(),
});

/** Update now, as the app leaves it for the job: `{ "version": 1, "at" }`. */
const RequestFile = z.object({ version: z.literal(1), at: z.string().min(1) });

const USUAL: OmpUpdateSchedule = {
  everyNights: OMP_UPDATE_NIGHTS.usual,
  installHour: OMP_UPDATE_HOURS.usual,
};

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw failure;
  }
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The settings file as an object; null when it is not one (missing, not JSON, another shape). */
function savedFrom(text: string | null): Readonly<Record<string, unknown>> | null {
  if (text === null) return null;
  const saved = parsed(text);
  return typeof saved === "object" && saved !== null && !Array.isArray(saved)
    ? (saved as Record<string, unknown>)
    : null;
}

/**
 * On while the app has written nothing; off when it wrote `enabled: false`, and when its file cannot be read, as the
 * job reads it, so the switch never shows on while the job stays off.
 */
function enabledFrom(text: string | null): boolean {
  if (text === null) return true;
  const saved = savedFrom(text);
  return saved !== null && saved.version === 1 && saved.enabled === true;
}

/** When the job looks and installs: each field the file holds within its range, else the usual one, as the job reads it. */
function scheduleFrom(text: string | null): OmpUpdateSchedule {
  const saved = savedFrom(text);
  if (saved === null || saved.version !== 1) return USUAL;
  const nights = ScheduleShape.shape.everyNights.safeParse(saved.everyNights);
  const hour = ScheduleShape.shape.installHour.safeParse(saved.installHour);
  return {
    everyNights: nights.success ? nights.data : USUAL.everyNights,
    installHour: hour.success ? hour.data : USUAL.installHour,
  };
}

/** The job's last word; null where none has run, or its file cannot be read. */
function jobFrom(text: string | null): OmpUpdateJob | null {
  if (text === null) return null;
  const status = StatusFile.safeParse(parsed(text));
  if (!status.success) return null;
  const { lastNight, running, pending, byRequest, blocked } = status.data;
  return {
    lastNight: { at: lastNight.at, result: lastNight.result },
    ...(running === undefined ? {} : { running }),
    ...(pending === undefined ? {} : { pending }),
    ...(pending === undefined || byRequest === undefined ? {} : { byRequest }),
    ...(blocked === undefined ? {} : { blocked }),
  };
}

/** An Update now the job has not taken yet; null when none waits (or its file cannot be read). */
function requestFrom(text: string | null): { readonly at: string } | null {
  const request = RequestFile.safeParse(text === null ? undefined : parsed(text));
  return request.success ? { at: request.data.at } : null;
}

export async function readOmpUpdates(files: OmpUpdateFiles): Promise<OmpUpdates> {
  const [settings, status, request] = await Promise.all([
    readText(files.settings),
    readText(files.status),
    readText(files.request),
  ]);
  return {
    enabled: enabledFrom(settings),
    schedule: scheduleFrom(settings),
    request: requestFrom(request),
    job: jobFrom(status),
  };
}

/** A file written whole through a file of its own beside it, so the job never reads half of one. */
async function writeWhole(path: string, value: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

/** Changes the settings named; the others keep what they read as now. The file is written whole, every field in it. */
export async function setOmpUpdates(
  files: OmpUpdateFiles,
  change: SetOmpUpdatesArgs,
): Promise<OmpUpdates> {
  const before = await readOmpUpdates(files);
  await writeWhole(files.settings, {
    version: 1,
    enabled: change.enabled ?? before.enabled,
    everyNights: change.everyNights ?? before.schedule.everyNights,
    installHour: change.installHour ?? before.schedule.installHour,
  });
  return await readOmpUpdates(files);
}

/**
 * Update now: leaves the job a request to look for a new omp and test it now (it installs at the install hour). One at
 * a time: while one waits, pressing again changes nothing. The app starts nothing itself; the job beside it does.
 */
export async function requestOmpUpdate(files: OmpUpdateFiles, at: Date): Promise<OmpUpdates> {
  const before = await readOmpUpdates(files);
  if (before.request === null)
    await writeWhole(files.request, { version: 1, at: at.toISOString() });
  return await readOmpUpdates(files);
}
