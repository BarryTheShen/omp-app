import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OmpUpdateJob, OmpUpdates } from "@omp-app/contracts";
import { z } from "zod";

/**
 * The two files of a job that updates omp beside the app, in the app's data folder, one writer each so neither undoes
 * the other: the job writes `status` after every night; the app writes `settings` when Settings → App → omp turns
 * automatic updates on or off, and the job reads it before it does anything.
 */
export interface OmpUpdateFiles {
  readonly status: string;
  readonly settings: string;
}

/** The job's file: `{ "version": 1, "lastNight": { "at", "result" }, "pending"?, "blocked"? }`; other fields are its own. */
const StatusFile = z.object({
  version: z.literal(1),
  lastNight: z.object({ at: z.string().min(1), result: z.string().min(1) }),
  pending: z.string().min(1).optional(),
  blocked: z.string().min(1).optional(),
});

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

/**
 * On while the app has written nothing; off when it wrote `enabled: false`, and when its file cannot be read, as the
 * job reads it, so the switch never shows on while the job stays off.
 */
function enabledFrom(text: string | null): boolean {
  if (text === null) return true;
  const saved = parsed(text);
  if (typeof saved !== "object" || saved === null) return false;
  const { version, enabled } = saved as { readonly version?: unknown; readonly enabled?: unknown };
  return version === 1 && enabled === true;
}

/** The job's last word; null where none has run, or its file cannot be read. */
function jobFrom(text: string | null): OmpUpdateJob | null {
  if (text === null) return null;
  const status = StatusFile.safeParse(parsed(text));
  if (!status.success) return null;
  const { lastNight, pending, blocked } = status.data;
  return {
    lastNight: { at: lastNight.at, result: lastNight.result },
    ...(pending === undefined ? {} : { pending }),
    ...(blocked === undefined ? {} : { blocked }),
  };
}

export async function readOmpUpdates(files: OmpUpdateFiles): Promise<OmpUpdates> {
  const [settings, status] = await Promise.all([readText(files.settings), readText(files.status)]);
  return { enabled: enabledFrom(settings), job: jobFrom(status) };
}

/** Turns automatic updates on or off: the settings file written whole through a file of its own beside it. */
export async function setOmpUpdates(files: OmpUpdateFiles, enabled: boolean): Promise<OmpUpdates> {
  await mkdir(dirname(files.settings), { recursive: true });
  const temporary = `${files.settings}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, enabled }, null, 2)}\n`);
  await rename(temporary, files.settings);
  return await readOmpUpdates(files);
}
