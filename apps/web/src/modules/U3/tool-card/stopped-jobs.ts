import type { BackgroundJobStop } from "@omp-app/contracts";
import { finishedOutcome, type StopOutcome, stoppedOutcome } from "./background-job";

/** The outcome a card shows for a stop the server kept: the same words a live stop shows. */
export function outcomeOfRecordedStop(stop: BackgroundJobStop): StopOutcome {
  return stop.status === "stopped" ? stoppedOutcome(stop.jobId) : finishedOutcome(stop.jobId);
}

/**
 * The outcome a card shows for the stop the server kept for its job, or undefined when that stop is not this card's.
 * omp numbers jobs per process, so a job launched after a stop can carry the same id: a stop recorded before the
 * card's launch was made for an earlier job. A card whose launch is unknown takes no kept stop.
 */
export function keptStopOutcome(
  stop: BackgroundJobStop | undefined,
  launchedAt: number | undefined,
): StopOutcome | undefined {
  if (stop === undefined || launchedAt === undefined || stop.at < launchedAt) return undefined;
  return outcomeOfRecordedStop(stop);
}

/**
 * The stop a card shows. A stop that arrived on this page always wins, and so does any fact the transcript delivers
 * or ends. Only a job the transcript still shows as running takes the kept stop: omp keeps no stop in the transcript,
 * so that running reading is the stale one the kept stop corrects after a reload or in another browser.
 */
export function resolveStopOutcome(
  live: StopOutcome | undefined,
  running: boolean,
  kept: () => StopOutcome | undefined,
): StopOutcome | undefined {
  if (live !== undefined) return live;
  return running ? kept() : undefined;
}
